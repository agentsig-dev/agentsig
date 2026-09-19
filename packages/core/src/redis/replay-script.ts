/**
 * Internal Redis 7 Lua operation. All keys share the configured Cluster hash tag.
 *
 * One bounded state document deliberately trades throughput for a small atomic
 * mutation surface: build/validate the replacement in Lua, then one MSET writes
 * state + epoch + absolute quarantine deadline. Redis script errors do not roll
 * back earlier writes, so there must be NO sequence of index mutations here.
 * No user-controlled script fragments or key names are interpolated.
 *
 * Timestamp and configuration integers are stored as decimal strings: Redis
 * cjson's numeric encoding precision must not round a retention deadline down.
 * Full scans are bounded by 10,000 records and a 32 MiB encoded-state ceiling.
 * Redis wall-clock jumps and undetectable replication rollback remain explicit
 * deployment risks; marker presence is not proof of intact history.
 */
export const REDIS_REPLAY_SCRIPT = String.raw`
local MAX = 9007199254740991
local MAX_BYTES = 33554432
local MAX_RECORDS = 10000

local function integer(text)
    if type(text) ~= 'string' or #text == 0 or #text > 16
        or not string.match(text, '^%d+$') then return nil end
    local value = tonumber(text)
    if not value or value < 0 or value > MAX or value ~= math.floor(value) then return nil end
    if string.format('%.0f', value) ~= text then return nil end
    return value
end

local function decimal(value) return string.format('%.0f', value) end
local mode = ARGV[1]
local horizon = integer(ARGV[2])
local capacity = integer(ARGV[3])
local quota = integer(ARGV[4])
local proposedEpoch = ARGV[5]
if #KEYS ~= 3 or (mode ~= 'setup' and mode ~= 'consume')
    or not horizon or horizon <= 0 or not capacity or capacity > MAX_RECORDS
    or not quota or quota > MAX_RECORDS or type(proposedEpoch) ~= 'string'
    or #proposedEpoch ~= 32 or not string.match(proposedEpoch, '^[0-9a-f]+$') then
    return 'unavailable'
end

local identity = ARGV[6]
local thumbprint = ARGV[7]
local duration = integer(ARGV[8])
if mode == 'consume' then
    if type(identity) ~= 'string' or #identity == 0 or #identity > 4096
        or not string.match(identity, '^[A-Za-z0-9_-]+$')
        or type(thumbprint) ~= 'string' or #thumbprint ~= 43
        or not string.match(thumbprint, '^[A-Za-z0-9_-]+$')
        or not duration or duration <= 0 then return 'unavailable' end
end

local time = redis.call('TIME')
-- Observation rounds DOWN: rounding up could expire a live nonce or end
-- quarantine before its actual deadline. New deadlines round UP instead,
-- preserving the complete supplied duration from Redis execution time.
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local deadlineBase = tonumber(time[1]) * 1000 + math.ceil(tonumber(time[2]) / 1000)
if now < 0 or deadlineBase > MAX or horizon > MAX - deadlineBase
    or (mode == 'consume' and duration > MAX - deadlineBase) then
    return 'unavailable'
end

local function save(state, epoch, untilText)
    local encoded = cjson.encode(state)
    if #encoded > MAX_BYTES then return false end
    -- Single mutating command: a failed MSET leaves the prior tuple untouched.
    -- No TTL on recovery markers; an idle instance restart must not erase them.
    redis.call('MSET', KEYS[1], epoch, KEYS[2], untilText, KEYS[3], encoded)
    return true
end

local function quarantine()
    local untilText = decimal(deadlineBase + horizon)
    local state = {
        version = '1', epoch = proposedEpoch,
        quarantineUntil = untilText, detectedAt = decimal(deadlineBase),
        lastTime = decimal(deadlineBase), horizon = ARGV[2],
        capacity = ARGV[3], quota = ARGV[4], records = {}
    }
    if not save(state, proposedEpoch, untilText) then return 'unavailable' end
    -- Suspected loss discards untrustworthy history only behind a complete new
    -- horizon from detection. Never make this an administrative early-open API.
    return 'quarantine'
end

for index = 1, 3 do
    local kind = redis.call('TYPE', KEYS[index]).ok
    if kind ~= 'none' and kind ~= 'string' then return quarantine() end
    if kind == 'string' then
        local limit = index == 3 and MAX_BYTES or 64
        if redis.call('STRLEN', KEYS[index]) > limit then return quarantine() end
    end
end

local epoch = redis.call('GET', KEYS[1])
local untilText = redis.call('GET', KEYS[2])
local encoded = redis.call('GET', KEYS[3])
if not epoch or not untilText or not encoded then return quarantine() end
local decoded, state = pcall(cjson.decode, encoded)
if not decoded or type(state) ~= 'table' or state.version ~= '1'
    or #epoch ~= 32 or not string.match(epoch, '^[0-9a-f]+$')
    or state.epoch ~= epoch or state.quarantineUntil ~= untilText then
    return quarantine()
end

local untilTime = integer(untilText)
local detectedAt = integer(state.detectedAt)
local lastTime = integer(state.lastTime)
local storedHorizon = integer(state.horizon)
local storedCapacity = integer(state.capacity)
local storedQuota = integer(state.quota)
if not untilTime or not detectedAt or not lastTime or not storedHorizon or storedHorizon <= 0
    or not storedCapacity or storedCapacity > MAX_RECORDS
    or not storedQuota or storedQuota > MAX_RECORDS
    or detectedAt > MAX - storedHorizon or untilTime ~= detectedAt + storedHorizon
    -- lastTime uses the same upper-rounded representation as deadlineBase.
    -- Comparing it to floor(now) would falsely detect regression within a ms.
    or lastTime < detectedAt or deadlineBase < lastTime or type(state.records) ~= 'table' then
    return quarantine()
end

-- One namespace is one enforcement policy. A second instance cannot shorten
-- quarantine or enlarge quotas by presenting different configuration.
if state.horizon ~= ARGV[2] or state.capacity ~= ARGV[3] or state.quota ~= ARGV[4] then
    return 'configuration-mismatch'
end

local recordCount = 0
local live = {}
local identities = {}
local liveCount = 0
local forKey = 0
local replayed = false
for index, record in pairs(state.records) do
    recordCount = recordCount + 1
    if recordCount > MAX_RECORDS or type(index) ~= 'number' or index < 1
        or index ~= math.floor(index) or index > #state.records
        or type(record) ~= 'table' then return quarantine() end
    local id = record.identity
    local key = record.thumbprint
    local deadline = integer(record.deadline)
    if type(id) ~= 'string' or #id == 0 or #id > 4096
        or not string.match(id, '^[A-Za-z0-9_-]+$')
        or type(key) ~= 'string' or #key ~= 43
        or not string.match(key, '^[A-Za-z0-9_-]+$')
        or not deadline or identities[id] then return quarantine() end
    identities[id] = true
    if deadline > now then
        liveCount = liveCount + 1
        live[liveCount] = record
        if mode == 'consume' and key == thumbprint then forKey = forKey + 1 end
        if mode == 'consume' and id == identity then
            if key ~= thumbprint then return quarantine() end
            replayed = true
        end
    end
end
if recordCount ~= #state.records or recordCount > storedCapacity then return quarantine() end

-- Inspect shared state without restarting or extending an existing quarantine.
if now < untilTime then return 'quarantine' end
if mode == 'setup' then return 'ready' end

-- Expiry, replay, per-key quota, total capacity, then insertion.
-- Do not rewrite any live replay record, even for a longer requested duration.
if replayed then return 'replayed' end
if forKey >= quota then return 'per-key-quota-exceeded' end
if liveCount >= capacity then return 'unavailable' end
live[liveCount + 1] = {
    identity = identity, thumbprint = thumbprint, deadline = decimal(deadlineBase + duration)
}
state.records = live
state.lastTime = decimal(deadlineBase)
if not save(state, epoch, untilText) then return 'unavailable' end
return 'accepted'
`;
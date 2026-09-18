# M2 origin, tekrar ve yerel kimlik politikası

Durum: 2026-09-18; yardımcılar uygulanmış ve hedefli testleri geçmiştir.
Tam profil ayrıştırıcısı, imzalayan ve çevrimdışı doğrulayıcı henüz tamamlanmadı.
Bu yardımcılar paket girişinden dışa aktarılmıyor.

## Origin kabulü ve kanonik kimlik

[Origin doğrulaması](../packages/core/src/profiles/agent-origin.ts) iki profilde
aynı yerel politikayı uygular:

- Yalnızca HTTPS ve dolu ASCII host kabul edilir.
- Şema ve host büyük/küçük harf farkı normalize edilir.
- Açık 443 portu kaldırılır; diğer portlar kabul edilmez.
- Sondaki tek eğik çizgi kabul edilir, kimlik anahtarına dahil edilmez.
- Yol, sorgu, fragment ve kullanıcı bilgisi reddedilir.
- IPv4/IPv6 literalleri ve URL ayrıştırıcısının IP’ye çevirdiği alternatif
  sayısal yazımlar reddedilir.
- ASCII dışı host reddedilir; IDNA dönüşümü ve DNS sorgusu yapılmaz.
- URL ayrıştırıcısının girdi onarması kimlik kabulü için kullanılmaz.

Örneğin HTTPS://AGENT.EXAMPLE:443/ ile https://agent.example aynı
https://agent.example kimlik anahtarına dönüşür.

**Kanonik origin yalnızca kimlik karşılaştırması içindir. İmzalanan başlık
değeri yeniden yazılmaz.** Boyut sınırı normalizasyondan önce özgün girdiye
uygulanır. URL’nin bu kontrolleri geçmesi alan adı sahipliğini kanıtlamaz.

[WG §5.5](../tests/fixtures/m2/sources/wg-protocol-00.txt:825) directory keşfinde
origin biçimini gerektirir. Port ve IP kısıtları daha dar yerel M2 politikasıdır.
[Cloudflare belgesi](../tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx:178)
HTTPS URI ve tırnaklı biçim ister; origin-only kısıtı Cloudflare zorunluluğu
değil, agentsig’in açıkça onaylanmış daha katı yerel politikasıdır.

## Ham tekrar reddi

[Tekrar denetimi](../packages/core/src/profiles/duplicates.ts), anlamsal
ayrıştırma tekrarları kaybetmeden ham Structured Fields oluşumlarını inceler:

- İmza metadata’sı veya bileşen parametresi tekrarı: malformed-signature.
- İmza değeri parametresi tekrarı: malformed-signature.
- Signature-Agent Dictionary üyesi veya parametresi tekrarı: malformed-agent.
- Aynı değerin iki kez yazılması da reddedilir.
- Aynı parametre adının farklı üye/bileşenlerde kullanılması tekrar sayılmaz.
- Teşhis, yinelenen adı belirtir; parametre değeri veya tam başlık yazılmaz.
  Görüntülenen ad 256 kod birimiyle sınırlandırılır, kısaltma açıkça belirtilir.

İmza tarafındaki denetim aday tag seçiminin önünde kullanılmalıdır; tekrar
eden tag ile adayın başka protokol gibi gizlenmesi engellenir. Bütçe aşımları
bozuk sözdizimi değil, mevcut resource-limit sonucunu korur.

[RFC 9421 §2.3](../tests/fixtures/profiles/sources/rfc9421-2.3.txt) ve
[§2.5](../tests/fixtures/profiles/sources/rfc9421-2.5.txt), ham parametre adı
tekrarlarını ayrıca reddeden açık bir hüküm içermez. §2.5 adım 2.1’deki ret,
parametreleriyle birlikte aynı bileşen tanımlayıcısının tekrarına ilişkindir.
İmza etiketlerinin benzersizliği ise RFC 9421 §4’ün ayrı şartıdır.

[RFC 9651 parametre ayrıştırması](../tests/fixtures/profiles/sources/rfc9651-parameters.txt)
ve [Dictionary ayrıştırması](../tests/fixtures/profiles/sources/rfc9651-dictionary.txt)
son değeri korur. M2’nin ham tekrar reddi bundan bilinçli olarak daha katıdır:
amaç farklı ayrıştırıcıların farklı değer seçmesi riskini azaltmaktır.
M1 motorunun ve genel SF paketinin davranışı değiştirilmemiştir.

## Açık yerel kimlik bağlaması

[Bağlama yardımcısı](../packages/core/src/profiles/agent-bindings.ts) yalnızca
yapılandırılmış thumbprint–origin ilişkilerini kullanır. Girdileri kopyalar;
aynı anahtar ve kanonik origin çiftinin eşdeğer yazımlarını tekilleştirir.
Kaynak bütçesi tekilleştirmeden önce tüm girdi oluşumlarını sayar.

Thumbprint modunda imzalı URL iddiasından alan adı kimliği türetilmez.
Açık bağlama modunda seçilen anahtarın ilişkisi yoksa agent-binding-missing;
ilişki var ama origin uyuşmuyorsa agent-binding-mismatch üretilir.
Başka bir anahtarın aynı origin’e bağlanması seçilen anahtara güven sağlamaz.

Eşleşen URL kimlik önerisi kanonik origin’i, onun well-known dizin adresini
ve local-configuration güven kaynağını taşır. TLS/dizin kanıtı veya operatör
adı çıkarımı yapılmaz. Bu yalnızca iç kimlik önerisidir: kripto, zaman,
test anahtarı politikası ve replay kontrolleri bitmeden doğrulanmış sonuç
olarak dışarıya verilmemelidir. Anahtar bağlamasını yenilemek replay geçmişini
kendiliğinden silmez.

## Test ve teslimat sınırı

Kaynak alıntıları ve 26 URL, 9 tekrar, 9 kimlik bağlama beklentisi üretim
uygulamasından önce 34b0d9a fixture commit’ine alınmıştır.
[Bağımsız denetim](../tests/profile-fixture-audit.test.mjs) kaynak/manifest
bütünlüğünü ve beklenti tutarlılığını sınar; üretim kodunu kullanmaz.

Yerel Windows / Node 22 üzerinde 48 origin, 18 tekrar ve 27 kimlik bağlama
testi geçti. Bu yardımcılar eklendikten sonra tam regresyon da başarılıdır:
3.754 birim testi, 9 entegrasyon testi, 32 bağımsız fixture denetimi,
M1 audit'i ve iki paketin derleme/tip kontrolleri geçti.
ESM/CJS tüketici testleri mevcut M1 girişlerini kapsar; yeni yardımcıların
paket dışa aktarımı ve tam doğrulayıcı entegrasyonu henüz tamamlanmadı.
Bu değişikliklerin uzak CI matrisi henüz doğrulanmadı. Push ve yayın yapılmadı.

## Aday seçimi, başlık biçimi ve bileşen desteği

[Aday seçimi](../packages/core/src/profiles/candidates.ts) önce ham tekrarları
denetler, ardından bütün imza çiftlerini ayrıştırır ve protokol tag’iyle seçim
yapar. İmza etiketinin adı seçim ölçütü değildir. Bozuk bir çift, başka protokol
tag’i taşısa bile imzasız trafik olarak kabul edilmez.

[Ajan başlığı ayrıştırması](../packages/core/src/profiles/agent-header.ts)
Dictionary ile eski String biçimini tel gösteriminden bir kez seçer.
Ayrıştırma veya doğrulama hatası diğer profili deneyerek başarıya çevrilmez.
WG’de her aday yalnızca kendi etiketiyle eşleşen üyenin iddiasını kullanır.
Desteklenmeyen keşif türü URL yolundan tahmin edilmez ve ağ erişimi başlatmaz.

[Asgari kapsam kontrolü](../packages/core/src/profiles/coverage.ts) iki profilde
de yöntem ve tam hedef URI ister. WG’de etikete karşılık gelen ajan üyesi,
Cloudflare profilinde ajan başlığının tamamı kapsanmalıdır. Ek bileşenlerin
geçerliliği ve profil desteği bu kontrolden ayrıdır.

[Bileşen desteği kontrolü](../packages/core/src/profiles/component-support.ts)
iki profilde de Signature veya Signature-Input alanını kapsayan adayı
unsupported-profile ile reddeder; alanın tamamını veya bir üyesini kapsamak
bu sınırı değiştirmez. Bu, WG’nin böyle bir özelliği yasakladığı anlamına
gelmez: zincirli kapsam M2’nin belgelenmiş yerel kapsamı dışındadır.
M4 proxy arkası dağıtımda ihtiyaç doğarsa ayrı bir kilometre taşıyla ele alınır.

Cloudflare’in sabitlenmiş belgesindeki destek dışı bileşenler ve parametreler
de unsupported-profile üretir. Teşhis, desteklenmeyen profil adı ile desteklenen
profil içindeki destek dışı bileşeni ayırır; bileşeni, varsa parametreyi ve
Cloudflare Limitations bölümü veya yerel M2 sınırı olan kaynağı belirtir.
Teşhis ayrıntıları donmuş sonuç kataloğuna yeni kod eklemez.

### Reddedilen aday sayımdan düşmez

Tag ile seçim, bileşen reddinden öncedir. İki adaydan biri diğer imzayı
kapsıyorsa ikisi de sayımda kalır:

- Varsayılan exactly-one politikası ambiguous-signatures üretir; nonce tüketilmez.
- Açık all/any politikasında dış adayın unsupported-profile sonucu korunur ve
  diğer aday bağımsız değerlendirilir.
- All başarılı olamaz; any ancak diğer aday bütün kimlik, kripto, zaman ve
  replay kontrollerini geçerse başarılı olabilir.

Reddedilen adayı yok saymak, ek imzalarla kabul politikasını yönlendirme riski
oluşturur. Bu nedenle değerlendirme sonuçları aday listesini yeniden filtrelemez.
[Sayım fixture’ları](../tests/fixtures/profiles/rejected-candidate-counting.json)
bu toplu davranışı sabitler. Mevcut testler seçim listesinin ve aday bazlı
retlerin korunmasını sınar; tam toplama ve nonce tüketimi entegrasyonu
henüz uygulanmamıştır.

### Bu alt adımın doğrulama durumu

Kapsam fixture’ları 37159c4; bileşen kısıtları ve reddedilen aday sayımı
fixture’ları 5f017f1 yerel commit’lerinde uygulamadan önce sabitlenmiştir.

Yerel Windows / Node 22 tam regresyonunda 3.866 birim testi, 9 entegrasyon
testi ve 35 bağımsız fixture denetimi geçti; derleme ve tip kontrolleri
başarılıdır. [Kriptografik zincir testleri](../packages/core/test/profile-crypto-chain.test.ts)
iki bağımsız imzalı örneği doğrular; yöntem, hedef sorgusu veya özgün ajan
değeri değişince imza reddedilir. Aynı kanonik origin’e dönüşmek, farklı
imzalı baytları eşdeğer kılmaz.

Tam profil imzalayanı, zaman/replay katmanı, çevrimdışı doğrulayıcı ve profil
paket dışa aktarımları henüz tamamlanmadı. Mevcut ESM/CJS tüketici testleri
M1 girişlerini kapsar. Yeni değişikliklerin uzak CI sonucu doğrulanmadı.
Push, yayın veya WG bildirimi yapılmadı.
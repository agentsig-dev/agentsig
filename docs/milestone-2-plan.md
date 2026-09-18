# M2 — çevrimdışı Web Bot Auth profil katmanı

Durum: **öneri; uygulama onayı bekleniyor**. Tarih: 2026-09-18.
Bu belge kod veya tamamlanmış uyumluluk iddiası değildir.
Depo: https://github.com/agentsig-dev/agentsig — npm kapsamı @agentsig.

## 1. Kapsam

M1 motoru değiştirilmeden onun üzerinde, @agentsig/core içinde ayrı profil alt
giriş noktası önerilir. Yeni npm paketi gerekmez. Kesin dış API fixture
sözleşmeleriyle birlikte onaya sunulur.

M2 iki sürümü sabit profil, profil bazlı imzalama/doğrulama, zaman politikası,
elle verilen JWKS, atomik replay arayüzü, bellek içi depo ve kapalı sonuç kodlarını
kapsar. Ağ, DNS, dizin fetch/cache, redirect, otomatik JWKS yenileme, framework
adaptörleri, fetch sarmalayıcısı, CLI ve canlı Cloudflare testi kapsam dışıdır.
Onay olmadan uygulama, push veya yayınlama yapılmaz.

## 2. Önceden onaylanan kararlar

- Varsayılan imzalayan profili **ietf-wg-protocol-00**.
- Açıkça seçilen uyumluluk profili **cloudflare-docs-2026-07-01**.
- İmzalayan otomatik downgrade veya sessiz yeniden deneme yapmaz.
- Doğrulayan iki biçimi tanır; kullanılan profili her adayın sonucunda raporlar.
- Hatalı biçim veya başarısız imza, diğer profili deneyerek başarıya çevrilmez.
- İki profilde de nonce varsayılan zorunludur; isteğe bağlı politika açıkça seçilir.
- İmzalama ömrü 60 sn; azami ömür/yaş 300 sn; saat toleransı 30 sn.
  Bu değerler profil başına yapılandırılır; protokol zorunluluğu değildir.
- Ed25519 ve Node yerleşik kripto kullanılır. M1 saf motoruna saat/ağ/depo yan etkisi eklenmez.
- Fixture'lar ve bağımsız beklenen çıktılar önce ayrı commit, uygulama sonra.

## 3. Profil kuralları ve kaynak kapısı

| Profil | Wire davranışı | Sabit referans |
| --- | --- | --- |
| ietf-wg-protocol-00 | Signature-Agent Dictionary; etiketle eşleşen imzalı üye; authority veya target-uri kapsamı; gerekli metadata | [WG-00 §5.2–5.5, 2026-09-01](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2) |
| cloudflare-docs-2026-07-01 | Tırnaklı Structured String; başlığın tamamı imzalı; belgelenmiş Cloudflare kuralları | [Cloudflare §4, sayfada görülen tarih 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#4-after-verification-sign-your-requests) |

Kaynak kapısı: WG-00 metni, varsa gerçek vektörleri ve Cloudflare dokümanının
değişmez commit/snapshot'ı, lisans ve SHA-256 bilgileriyle sabitlenir.
Cloudflare profil tarihine karşılık gelen kaynak bulunamazsa güncel sayfa o
tarihteki kaynakmış gibi etiketlenmez; fark raporlanır ve onay istenir.
Temsili örnek imza baytları gerçek vektör sayılmaz. Kendi fixture'larımız bu
etiketle, M2 uygulamasından bağımsız Node kriptografisiyle denetlenir.

Discovery türlerinin ayrıştırılması ağ çağrısı anlamına gelmez. M2 başlangıcı
için yalnızca directory türünü işlemek önerilir; diğer türlere açık destek-dışı
sonuç verilir. Alternatif: jwks_uri/cimd değerlerini de yalnızca önceden
yapılandırılmış yerel kimlikler olarak desteklemek. Bu daha geniş kapsam ve
normalizasyon testleri gerektirir; CIMD dokümanı indirilmez.

## 4. Çevrimdışı anahtar ve kimlik modeli

JWKS yalnızca uygulamanın güvenilir yapılandırmasından alınır; istek içinden
gelen JWKS veya anahtar materyali kabul edilmez. Yapılandırma yüklenirken kopyalanır,
doğrulanır ve değişmez bir anahtar görünümü oluşturulur. Çalışırken sessiz mutasyon yoktur.

Anahtar seçimi SHA-256 JWK thumbprint ile yapılır; keyid bir URL veya keyfi kid
eşlemesi olarak kullanılmaz. İmza başlığındaki keyid yeniden hesaplanmış thumbprint
ile eşleşmelidir. Yalnızca açık OKP/Ed25519, geçerli base64url ve 32 bayt x kabul
edilir; özel d alanı reddedilir. use/key_ops kısıtları mevcutsa doğrulama amacıyla
uyumlu olmalıdır. JWK alg değerinin JOSE bağlamı ile HTTP alg değeri birbirine
karıştırılmaz; kabul matrisi kaynak ve negatif fixture'larla sabitlenir.

İki olası kimlik modu:
- **Öneri: yalnızca anahtar kimliği.** Elle JWKS verilince başarı anahtar
  thumbprint'ine atfedilir. İmzalı Signature-Agent değeri bir iddia olarak ayrıca
  raporlanabilir, ancak doğrulanmış alan adı/operatör değildir.
- **Açık yerel bağlama:** Uygulama agent identifier → JWKS eşlemesi verir.
  Başarıda güven kaynağı “local-configuration” olarak raporlanır; bu canlı TLS
  çözümlemesi veya protokolün dizin kanıtı değildir. Aynı anahtarın başka URL'de
  bulunması otomatik bağlama sağlamaz; operatör adı uygulamaya aittir.

Kullanıcıdan onay bekleyen öneri: iki modu desteklemek, düz JWKS için ilkini
kullanmak; URL bağlamasını yalnızca açık yapılandırmayla etkinleştirmek.
Statik anahtar değişimi yeni doğrulayıcı/anahtar görünümüyle yapılır; aynı replay
deposu korunur. Anahtar rotasyonu tek başına daha önce kabul edilmiş nonce'ları silmez.

## 5. Zaman politikası — kesin sınırlar için öneri

Tüm değerler güvenli tamsayı Unix saniyesi; saat bağımlılığı enjekte edilebilir.
Bir doğrulama aşamasında tek saat örneği kullanılır. created ve expires zorunlu;
negatif zaman, expires ≤ created ve limit dışı ömür açık ret nedenidir.

Önerilen kabul eşitsizlikleri:
- created ≤ now + skew
- expires − created ≤ maxLifetime
- now < expires + skew
- now < created + maxAge + skew

Son kabul sınırı hariçtir: tam sınırda istek reddedilir; böylece o sınırda
nonce kaydını temizlemek replay penceresi açmaz.
Alternatif: toleransı yalnızca gelecekteki created için uygulamak; sona ermiş
imzayı asla uzatmaz, fakat dağıtık saat farklarında daha çok ret üretir.
Öneri yukarıdaki simetrik tolerans; mevcut 60/300/300/30 varsayılanları değişmez.

Replay saklama üst sınırı önerisi: max(tüketim anı, created) + maxAge + skew.
Sabit 330 sn kullanılmaz. created 30 sn ileride kabul edilmişse varsayılanlarla
ilk kabulden 360 sn sonrasına kadar saklama gerekebilir.
Daha erken temizleme alternatifi: min(expires, created + maxAge) + skew;
daha az bellek kullanır, ama bütün doğrulayıcıların aynı kabul politikasını
uygulaması gerekir. Öneri ilk, korumacı üst sınırdır.

Asenkron depo beklemesinden sonra zaman tekrar sınanır; bu sırada süresi dolan
imza kabul edilmez. Tüketilmiş nonce geri alınmaz: erişilebilirlik pahasına
replay güvenliği korunur.

Saat geri giderse daha önce temizlenen nonce yeniden geçerli olmamalıdır.
Öneri: enjekte edilebilir duvar ve monoton saat; süreçte doğrulama zamanı
geriye yürütülmez ve temizleme aynı zaman politikasıyla yapılır. Büyük saat
sıçraması/clock rollback açık saat-hatası sonucu verir; kayıtlar topluca silinmez.
Alternatif: daha katı şekilde her geri gidişte doğrulamayı durdurmak.
Kesin sapma eşiği ve süre aritmetiği fixture'ları koddan önce onaylanacaktır.
Depo kaybı veya süreç yeniden başlatma sonrası bellek içi replay geçmişinin
korunmadığı açıkça belgelenir; süreçler arası garanti verilmez.

## 6. ReplayStore ve bellek içi depo

Önerilen sözleşme: consume(scope, keyThumbprint, nonce, retainUntilEpochSeconds)
→ Promise ile accepted / replayed / unavailable / capacity-exceeded sonucu.
Bunlar ayrı sorgu ve yazma değil, tek atomik işlem olmalıdır.

Scope doğrulayıcının yapılandırdığı güven alanıdır; istekten alınmaz.
Depo anahtarı scope + thumbprint + nonce üçlüsünün çakışmasız/uzunluk ayraçlı
kodlanmasıyla türetilir. Profil ve imza etiketi anahtara katılmaz; bunları
değiştirerek tekrar kontrolünden kaçış sağlanamaz. Aynı güven alanındaki
doğrulayıcılar aynı depo örneğini kullanmalıdır.

Sıra: sınırlı ayrıştırma → profil/kapsam → yerel anahtar seçimi →
kriptografi → son zaman kontrolü → atomik nonce tüketimi → zaman yeniden kontrolü.
Geçersiz imza nonce'u tüketmez. “Optional” yalnızca eksik nonce'u gevşetir;
mevcut nonce tekrarı, depo arızası veya kapasite aşımı başarıya çevrilmez.

Bellek içi depo: kontrol ve ekleme arasında await yok; kapasite kontrollü,
sonlanmış kayıtlar temizlenir, yaşayan kayıtlar LRU ile atılmaz.
Önerilen sınırlar: 10.000 kayıt, nonce en fazla 256 ASCII bayt, üretilen nonce
32 rastgele baytın base64url gösterimi. Gelen nonce'un entropisi kanıtlanamaz;
istemci üretimi ve depo tekrar kontrolü ayrı sorumluluklardır.
Ömrü en fazla 360 sn olan kayıtlarla 10.000 kapasite, sürekli yeni nonce
akışında yaklaşık 28 kabul/sn dolum noktasına karşılık gelir; genel performans
vaadi değildir. Alternatif 100.000 kayıt daha yüksek hacim ve bellek maliyetidir.
Yerel JWKS için öneri: 64 anahtar, 256 KiB giriş; ayrı profil imza sayısı 16.
Bunlar protokol limitleri değil, onay bekleyen kaynak varsayılanlarıdır.

## 7. VerificationResult — kapalı sonuç modeli önerisi

Aşağıdaki kod kümeleri öneridir; uygulamada serbest metin reason bulunmayacak.
Sonuç birlikleri başarı, geçersiz girdi ve doğrulanamama durumlarını ayıracak.
Yalnızca başarılı sonuçta doğrulanmış anahtar kimliği bulunur. Başarısız sonuçta
ajanın iddia ettiği kimlik “verified identity” alanına yerleştirilmez.

| Durum | Kapalı neden kodları |
| --- | --- |
| unsigned | NO_SIGNATURE |
| verified, replay korumalı | NONCE_CONSUMED; replayProtected: true |
| verified, açık optional politika ve eksik nonce | NONCE_ABSENT_OPTIONAL; replayProtected: false |
| invalid | MALFORMED_SIGNATURE, MALFORMED_AGENT, AMBIGUOUS_PROFILE, MISSING_REQUIRED_PARAMETER, INVALID_PARAMETER, INVALID_TIME_RANGE, CREATED_IN_FUTURE, SIGNATURE_EXPIRED, SIGNATURE_TOO_OLD, LIFETIME_EXCEEDED, INSUFFICIENT_COVERAGE, KEY_ID_MISMATCH, ALGORITHM_MISMATCH, SIGNATURE_MISMATCH, NONCE_REQUIRED, NONCE_INVALID, REPLAY_DETECTED |
| unverified | UNSUPPORTED_PROFILE, UNSUPPORTED_DISCOVERY_TYPE, PROFILE_DISALLOWED, UNKNOWN_KEY, AGENT_BINDING_MISSING, RESOURCE_LIMIT, REPLAY_STORE_UNAVAILABLE, REPLAY_STORE_FULL, CLOCK_UNAVAILABLE |

Yanlış yerel JWKS, limit veya saat yapılandırması oluşturma aşamasında tipli
yapılandırma hatasıdır; saldırganın imzası bozukmuş gibi raporlanmaz.
Beklenmeyen programlama hataları genel invalid sonucuyla gizlenmez.
Doğrulanan sonuç ayrıca profil, etiket, imzalanan bileşenler, key thumbprint,
doğrulama zamanı ve güven kaynağını taşır. Bu, erişim izni değildir.

Çoklu imza için öneri: açık etiket seçimi; bilinçsiz “ilk geçerli imza yeter”
politikası yok. Alternatif: tüm etiketlerin bağımsız sonuç dizisi; uygulama
any/all kuralını açıkça uygular. M1 tüm-çiftler ayrıştırıcısı bozuk bir çiftte
tüm çağrıyı reddeder; M2 başlangıcında bu sınır korunur, sessiz parsiyel kabul yok.
Aynı nonce'a sahip çoklu adaylar için tüketim sırası ve tek kullanımlık doğrulama
davranışı fixture'larda açıkça sınanır; verify salt gözlem işlemi değildir.

## 8. Onay bekleyen güvenlik seçenekleri

| Karar | Öneri | Alternatif / maliyet |
| --- | --- | --- |
| JWKS kimlik bağlaması | Düz JWKS → yalnızca thumbprint; URL için açık yerel eşleme | Yalnızca URL'ye bağlı yapılandırma: daha katı, basit anahtar testi zorlaşır |
| İmzalama kapsamı | İki profilde method + target-uri + profilin ajan bileşeni | Minimum authority + ajan: aracı uyumu iyi, yol/yöntem bağlanmaz |
| Doğrulama kapsamı | Profil minimumu ve ayrıca yapılandırılabilir zorunlu bileşenler; sonuç kapsamı açık taşır | Method + target-uri zorunlu: daha güçlü istek bağlama, minimum protokol istemcilerini reddeder |
| Gövde | M2 gövde doğrulaması yapmaz; belgelenmiş sınırlama | Digest/body doğrulamasını eklemek: bu planın kapsamını büyütür |
| Zaman ve TTL | §5 simetrik tolerans ve korumacı saklama | Expiry toleransını kaldırmak / daha erken temizlemek |
| Kapasite | 10.000 kayıt, canlı kayıt atma yok, dolulukta başarı yok | 100.000: daha fazla bellek; yaşayan kayıtları silmek önerilmez |
| Çoklu imza | Açık etiket seçimi | Sonuç dizisi; uygulama açık kabul/tüketim kuralı seçer |
| Bilinen test anahtarları | Normal doğrulayıcıda reddet; testte açık izin | Tümüyle uygulamaya bırakmak yanlışlıkla üretim kullanımı riskini artırır |
| Keşif türleri | M2 directory biçimi; diğerleri destek-dışı | Tamamen yerel jwks_uri/cimd eşleme desteğiyle test kapsamı artar |

İmzalayan nonce kullansa bile saldırgan ilk kullanım yarışını kazanabilir.
Nonce gövdeyi, yolu veya yöntemi kendiliğinden bağlamaz. Kapsam seçenekleri bu
nedenle replay seçeneklerinden ayrı karardır.
Bu tablodaki öneriler otomatik onay değildir; uygulama öncesinde kullanıcı seçer.

## 9. Fixture-first commit sırası ve kabul kapıları

1. Güvenlik kararları ve kesin API sözleşmesi onaylanır.
2. **Ayrı fixture commit'i:** sabit iki profil kaynağı; ayrı wire/AST/base/imza
   beklentileri; gerçek vektör/temsili örnek ayrımı; lisans ve içerik özetleri.
3. Zaman sınır tabloları, JWKS negatif verileri ve replay olay dizileri veri
   olarak kaydedilir. Beklentiler M2 uygulamasından üretilmez.
4. Fixture audit genişletmesi fixture commit'ini ve referans kriptografisini
   doğrular; M1 fixture'ları değiştirilmez.
5. Profil codec'leri, RFC 7638/8037 thumbprint, yerel JWKS doğrulaması eklenir.
6. Enjekte edilen saatle profil başına zaman politikası eklenir.
7. Atomik replay sözleşmesi ve kapasitesi sınırlı bellek içi depo eklenir.
8. Kapalı sonuç modeli ve çevrimdışı doğrulayıcı birleştirilir.
9. M1 testleri, yeni fixture/negatif/property testleri, ESM/CJS ve CI matrisi
   çalıştırılır; her ana aşamada kısa rapor verilir. Push/yayın kullanıcıya aittir.

Zorunlu testler: iki profilin çapraz reddi ve downgrade yokluğu; etiket/ajan
üyesi uyuşmazlığı; sınır saniyelerinde kabul/ret; saat geri/ileri sıçraması;
gelecekteki created ile erken TTL boşluğu; 100 eşzamanlı aynı istekte tek kabul;
geçersiz imzanın nonce tüketmemesi; optional noncesiz açık korumasız sonuç;
kapasite doluluğu/depo hatası; farklı scope/anahtar ayrımı ve profil değiştirme
ile replay kaçışının engellenmesi; JWKS içinde özel anahtar/yanlış eğri/bozuk
base64url/çakışan kid; URL iddiasının kendiliğinden doğrulanmış kimliğe dönüşmemesi.
İşlem sırasında ağ çağrısı olmadığını kanıtlayan testler ve bilinmeyen anahtarda
fetch'e düşülmediği kontrolü bulunur.

## 10. Bu turda yapılmayanlar

M2 kaynak snapshot'ı, fixture üretimi, API uygulaması, zaman kontrolü veya replay
deposu eklenmedi. Ağ katmanının SSRF, DNS rebinding, HTTP cache ve otomatik
rotasyon kararları sonraki kilometre taşına ertelendi.
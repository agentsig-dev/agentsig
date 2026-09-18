# @agentsig/core

Node 20+ için framework bağımsız RFC 9421 HTTP Message Signatures motoru.
Ed25519 kriptografisi Node'un yerleşik kripto modülünü kullanır.
Tek çalışma zamanı bağımlılığı @agentsig/structured-fields paketidir.
ESM ve CommonJS çıktıları ile her iki biçim için tip bildirimleri sağlanır.

**Durum:** Saf RFC motoru ve ayrı çevrimdışı Web Bot Auth profil katmanı mevcuttur.
İki profilin tam round-trip ve ESM/CJS tüketici testleri yerelde geçmiştir;
güvenlik denetiminden geçmiş veya üretime hazır olduğu iddia edilmez.

## İki ayrı giriş

- @agentsig/core: [saf RFC 9421 motoru](src/index.ts); saat, güven ve replay politikası içermez.
- @agentsig/core/profiles: [profil API'si](src/profiles.ts); imzalayan, çevrimdışı
  doğrulayıcı, yerel açık JWKS yükleyicisi ve paylaşılan saat/replay bağlamı.

[Çevrimdışı kullanım ve güven sınırları](../../docs/offline-verification.md)
profil yapılandırmasını, çoklu aday politikasını ve kimlik türlerini açıklar.
Anahtar rotasyonunda ortak bağlam korunmalıdır; istek başına yeni bellek bağlamı
oluşturmak replay korumasını etkisizleştirir. Ağdan keşif ve gövde digest
karşılaştırması uygulanmamıştır. Profil başarısı erişim yetkisi değildir.

## Saf motorun dört işlemi

Dış motor API'si [paket girişinde](src/index.ts) tanımlıdır.

| İşlem | Girdi | Çıktı |
| --- | --- | --- |
| [parseSignatureHeaders()](src/signature-input.ts:118) | Sıralı başlık oluşumları ve isteğe bağlı bütçe değişiklikleri | Etiketle eşleştirilmiş imza girdileri ve imza baytları |
| [createSignatureBase()](src/signature-base.ts:132) | Mesaj bağlamı, imza girdisi, alan türleri ve bütçe | Kanonik metin ve baytlar |
| [signHttpMessage()](src/crypto.ts:42) | Mesaj, imza girdisi, Ed25519 özel anahtarı | Bir etikete ait iki imza başlığının değerleri |
| [verifyHttpSignatureCryptography()](src/crypto.ts:80) | Mesaj, ayrıştırılmış imza, Ed25519 açık anahtarı | Kriptografik geçerlilik veya neden kodlu ret |

Kriptografik işlemler Promise döndürür; mevcut Node işlemi sınırlı girdi üzerinde
senkron çalışır. Bu API işin bir worker'a taşındığı anlamına gelmez.
İmzalayıcı ön-hash uygulamaz; RFC 9421 §3.3.6'daki saf Ed25519 kullanılır.

### Mesaj ve anahtar sözleşmesi

[Türler](src/types.ts) sıralı başlık çiftleri kullanır; tekrarlar ve geliş sırası
korunmalıdır. Başlık adları büyük/küçük harfe duyarsız eşleştirilir, imza bileşeni
adları ise küçük harfli olmalıdır.

Metin başlık değerleri ASCII olarak yorumlanır. ASCII dışı özgün HTTP oktetleri
için bayt dizisi ve binary-wrapped bileşen kullanılmalıdır; UTF-8/Latin-1 tahmini
yapılmaz. HTTP/1.1 eski satır katlamaları yalnızca sürüm bağlamı açıkça sağlanırsa
çözülür. Kalan CR/LF karakterleri reddedilir.

Mutlak hedef URI, uygulamanın gördüğü dış HTTP(S) isteğini doğru temsil etmelidir.
Ham istek hedefi gereken bileşende ayrıca sağlanır; URI'den tahmin edilmez.
Reverse proxy başlıklarına otomatik güvenilmez. Mutlak URI, ham hedef ve başlık
bağlamını tutarlı sağlamak çağıranın sorumluluğudur.

İmzalayıcı özel, doğrulayıcı açık Ed25519 anahtar nesnesi bekler. Anahtar metni
otomatik içe aktarılmaz. Açıkça belirtilmiş imza algoritması Ed25519 ile
çelişirse işlem reddedilir.

İmzalayıcı mevcut başlıkları değiştirmez. Dönen değerlerin başka imzaları ezmeden
birleştirilmesi çağıranın açık işlemidir; etiket çakışmalarına dikkat edilmelidir.

## Saf motorun kapsamı

| RFC özelliği | Motor girişi |
| --- | --- |
| Sıralı başlık oluşumları, OWS, açık HTTP/1.1 obs-fold bağlamı | Desteklenir |
| Structured Field katı serileştirme ve Dictionary üyesi seçimi | Alanın türü biliniyorsa desteklenir |
| Her başlık oluşumunu ayrı binary-wrapped kodlama | Desteklenir |
| Method, target URI, authority, scheme, path, query | Desteklenir |
| Ham request-target | Çağıran ham bağlamı sağlarsa desteklenir |
| Tekil query parametresi | RFC form çözümleme/kodlama kurallarıyla desteklenir; tekrar eden isim reddedilir |
| Response status ve ilgili request bileşenleri | Açık bağlamla desteklenir |
| Çoklu imza | Etiket başına ayrıştırılır/doğrulanır; otomatik kabul politikası yoktur |
| Trailer | Açıkça reddedilir |
| Ed25519 dışı kriptografi | Açıkça reddedilir |
| Bilinmeyen türetilmiş bileşen veya bileşen parametresi | Açıkça reddedilir |
| Bilinmeyen imza meta verisi | Desteklenen SF türündeyse imzaya dahil edilir; anlamı yorumlanmaz |
| Web Bot Auth profilleri, yerel JWKS, nonce ve saat | Ayrı profil girişinde uygulanır; saf motorun parçası değildir |
| Ağdan keşif, dizin cache'i | Henüz uygulanmadı |

İmza meta verisi ve bileşen tanımları RFC 8941 türlerini kullanır; RFC 9651 Date
ve Display String ekleri bu konumlarda kabul edilmez. Bilinen HTTP Structured
Field değerleri kendi alan türüne göre RFC 9651 altyapısıyla işlenebilir.
Sabit Dictionary alan bilgisi imza başlıkları ve Content-Digest için sağlanır;
diğer alanların türü çağıran tarafından bildirilir.

Tam RFC 9421 algoritma/özellik desteği iddia edilmez. Yukarıdaki kapsam tablosu,
testler ve kararlı hata sonuçları destek sınırını tanımlar.

## Saf motorun güven sınırı

**Yalnızca kriptografik geçerlilik aşağıdakileri kanıtlamaz:**
- Açık anahtarın belirli bir ajan, alan adı veya operatöre ait olduğunu.
- İsteğin yeni olduğunu veya daha önce işlenmediğini.
- İmzanın oluşturulma/sona erme zamanlarının kabul edilebilir olduğunu.
- İmzalanmamış yol, query, başlık veya gövdenin bütünlüğünü.
- Content-Digest başlığıyla gerçek gövdenin eşleştiğini.
- İsteğin yetkili, iyi niyetli veya hız sınırından muaf olduğunu.

Saf motoru doğrudan kullanan çağıran hangi bileşenlerin zorunlu olduğunu
belirlemeli, güvenilir anahtarı seçmeli ve tam doğrulama politikalarını ayrıca
uygulamalıdır. Ayrı profil doğrulayıcısı M2 kapsam, yerel kimlik, zaman ve replay
kontrollerini birleştirir; operatör itibarı veya yetkilendirme sağlamaz.
Content-Digest başlığını imzalamak, gerçek gövdenin doğrulandığı anlamına gelmez.
RFC test anahtarları kamuya açıktır; üretimde kesinlikle kullanılmamalıdır.
Profil katmanı bilinen test anahtarlarını varsayılan reddeder.

Ayrıştırıcı tüm etiket çiftlerini döndürür; herhangi bir çiftte karşılık
eksikse bu tüm-çiftler API'si hata verir. İki imza başlığı da yoksa boş dizi
döner. Tek bir imzanın başarısı diğer imzaların kabul edildiği anlamına gelmez.

## Kaynak limitleri ve hatalar

[Dondurulmuş core bütçeleri](src/limits.ts) dışa aktarılır. Başlık, URI, SF ve
imza tabanı boyutları için 16 KiB başlangıç değeri kullanılır; bu değer Node'un
varsayılan başlık boyutu referansıyla seçilmiş yerel politikadır.
Birleşik imza alanı değerleri ayrıca toplam olarak sınanır.
İmza tabanı genişleyebileceği için geçerli küçük başlıklar bile çıktı bütçesini
aşabilir. İmzalanan veri hiçbir zaman sınırı karşılamak için kesilmez.

Core her SF çağrısında kendi bütçesini açıkça geçirir; SF paketinin varsayılanını
değiştirmek core limitlerini sessizce değiştirmez. Çağrı başına limit değişikliği
mümkündür. Daha büyük bütçeler daha fazla CPU/bellek maliyeti demektir.

[Hata türleri](src/errors.ts) içerik veya anahtar materyalini mesajlara yazmaz.
Beklenen kriptografik retler sonuç olarak döner; yanlış çağıran yapılandırması
hata olarak iletilir. Limit hataları sınır, üst değer ve gözlenen değeri taşır.
Kriptografik sonuç kaynak reddini ayrı bir neden koduyla belirtir.

## Testler ve kaynaklar

Dört bağımsız golden takımı ayrıştırma, imza tabanı, imzalama ve doğrulamayı
[RFC 9421 B.1.4 ve B.2.6](https://www.rfc-editor.org/rfc/rfc9421.html#appendix-B.2.6)
verileriyle sınar. İmzalama testi yayımlanmış baytları birebir üretir; doğrulama
testi kendi imzalayıcımızı kullanmaz. Fixture'lar bayt olarak okunur.

[Kaynak ve lisans kaydı](../../docs/fixture-provenance.md), upstream commit'ini,
kaynak özetlerini ve satır sonu kontrollerini açıklar. Negatif/property testleri,
ESM/CJS tüketici kontrolleri ve Node 20/22/24 × Windows/Linux CI matrisi mevcuttur.
CI tanımının varlığı bütün matrisin çalıştırıldığı anlamına gelmez.
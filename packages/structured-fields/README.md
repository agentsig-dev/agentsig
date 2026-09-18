# @agentsig/structured-fields

Node 20+ için RFC 9651 Structured Fields ayrıştırma ve kanonik serileştirme.
Çalışma zamanı bağımlılığı yoktur; ESM ve CommonJS çıktıları sağlanır.
Paket geliştirme aşamasındadır; güvenlik denetiminden geçmiş değildir.

## API

Dış API [paket girişinde](src/index.ts) tanımlanır.

| İşlem | Sözleşme |
| --- | --- |
| [parse()](src/parse.ts:74) | Birleştirilmiş ASCII alan değerini RFC anlamsal modeline dönüştürür |
| [parseRaw()](src/parser.ts:29) | Özgün metni, konumları ve tekrarları koruyan ham AST döndürür |
| [serialize()](src/serializer.ts:33) | Anlamsal modelden kanonik ASCII alan değeri üretir |
| [serializeMember()](src/serializer.ts:43) | Parametreli öğe veya iç listeyi serileştirir |
| [decimalFromString()](src/decimal.ts:16) | Ondalık metni tam aritmetikle üç basamağa, eşit uzaklıkta çift sayıya yuvarlar |
| [getParameter()](src/types.ts:131) | Sıralı parametre modelinde anahtarla erişim sağlar |
| [getMember()](src/types.ts:136) | Sıralı sözlük modelinde anahtarla erişim sağlar |

Ayrıştırıcılara alan türü açıkça verilir. Girdi tek bir birleştirilmiş alan
değeridir; HTTP adaptörü aynı adlı bütün alan satırlarını geliş sırasıyla
virgül ve boşluk kullanarak birleştirmelidir. Başlık adları girdiye dahil edilmez.
Girdi metin veya bayt dizisi olabilir; ASCII dışı tel verisi reddedilir.

Boş liste/sözlük serileştirmesi boş metin döndürür. HTTP adaptörü bu durumda
alanı tamamen atlamalıdır; boş değerli başlık üretmekle alanı atlamak aynı değildir.

## Ham AST ve anlamsal model

[Tür sözleşmeleri](src/types.ts) tamsayı, ondalık, token, string, bayt dizisi,
boolean, tarih ve Display String değerlerini ayrı temsil eder.

Ham AST özgün birleştirilmiş girdiyi ve yarı açık konum aralıklarını korur.
ASCII girdide karakter ve bayt konumları aynıdır. Boşluklar, sayısal yazım ve
tekrarlanan üyeler kaybolmaz. Bu konumlar ayrı HTTP satırlarına değil,
birleştirilmiş değere aittir.

Anlamsal model RFC 9651 gereği tekrarlanan anahtarın son değerini kullanır;
anahtarın ilk konumunu korur. Serileştirici anlamsal model bekler; doğrudan
verilen tekrar eden anlamsal anahtarları belirsizliği gizlememek için reddeder.
Ham AST'yi kanonikleştirmeden özgün biçimde incelemek ayrı bir kullanım yoludur.

Bayt değerleri bağımsız standart bayt dizileri olarak döner. Türlerin salt okunur
işaretlenmesi derin çalışma zamanı değişmezliği sağlamaz; çağıran sonuçları
değiştirirse bunları tekrar doğrulamadan güven sınırında kullanmamalıdır.

## Kaynak bütçeleri

[Dondurulmuş varsayılan bütçe](src/limits.ts:18) dışa aktarılır.
Her çağrı kısmi bütçe değişiklikleri kabul eder; varsayılan nesne değiştirilmez.

| Kaynak | Varsayılan |
| --- | ---: |
| ASCII girdi | 1 MiB |
| Kanonik çıktı | 1 MiB |
| Liste/sözlük üye oluşumu | 1024 |
| İç liste başına öğe | 256 |
| Öğe/iç liste başına parametre oluşumu | 256 |
| Anahtar | 1024 karakter |
| Token | 8192 karakter |
| Tek çözülmüş string/bayt dizisi | 64 KiB |
| İşlem genelindeki oluşumlar | 65.536 |

Her öğe, iç liste ve parametre oluşumu toplam bütçeye sayılır. Sözlük anahtarı
kendi üyesinden ayrı bir oluşum sayılmaz. Tekrarlar anlamsal çözümlemeden önce
sayılır; tekrarlar kullanılarak bütçe aşılmaz. Toplam bütçe, tekil sınırları
aşmayan bir alanı da reddedebilir.

Sınırlar büyüyen veri tahsislerinden önce denetlenir. Bunlar mutlak heap kullanım
ölçümleri değildir: ham AST, anlamsal model ve geçici kodlama nesnelerinin ek
bellek maliyeti vardır. Sıfır limit bilinçli kapatma için kullanılabilir;
negatif, kesirli veya sınırsız limitler reddedilir.

Bütçeler yerel politikalardır, RFC'nin zorunlu üst sınırları değildir. Daha düşük
özel bütçeler RFC'nin genel ayrıştırıcılar için belirttiği asgari kapasitelerin
altında kalabilir; bu nedenle tüm geçerli alanların kabul edileceği vaat edilmez.

## Hata ve güvenlik davranışı

- [SfSyntaxError](src/errors.ts:14): tüm alanı geçersiz kılan tel sözdizimi hatası.
- [SfSerializationError](src/errors.ts:40): geçersiz anlamsal serileştirme girdisi.
- [SfLimitError](src/limits.ts:33): sınır adı, üst değer ve gözlenen değer.
- [SfConfigurationError](src/limits.ts:48): geçersiz bütçe yapılandırması.

Hatalar gelen başlık içeriğini mesajlarına eklemez. Hatalı UTF-8 değiştirme
karakteriyle onarılmaz. Display String içerikleri Unicode normalizasyonuna veya
güvenli görüntüleme filtresine tabi tutulmaz; arayüzde gösterimden önce uygulama
uygun kaçış işlemlerini yapmalıdır. Bu paket kimlik doğrulama, kriptografi,
HTTP mesaj doğrulaması veya yetkilendirme sağlamaz.

## Test kaynakları

[Fixture kaynak ve lisans kaydı](../../docs/fixture-provenance.md) RFC kaynaklarını
ve HTTP WG test takımının sabit commit'ini açıklar. Upstream dosyalar değiştirilmez.
Testler beklenen kanonik çıktıları üretim ayrıştırıcısından türetmez.
Tekrarlanabilir property testleri, negatif girdiler, bütçe sınırları ve ESM/CJS
tüketici testleri ayrıca bulunur. Test başarısı güvenlik denetimi yerine geçmez.

Proje kodu MIT lisanslıdır. Test fixture'ları kendi kaynak lisanslarını korur.
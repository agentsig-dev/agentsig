# Ertelenen işler ve güvenlik dışı uygulama seçimleri

Tarih: 2026-09-19. Bu kayıt, onaylanmış güvenlik sözleşmelerini değiştirmez.

## Karar alma sınırı

Kullanıcı talimatı: doğrulayıcının yanlış doğrulanmış sonuç üretmesini
etkilemeyen ayrıntılarda makul varsayılan seçilir, burada kaydedilir ve
yeniden onay sorulmaz. Yanlış kabulü etkileyen belirsizliklerde onay alınır.
Yalnızca beklenen ret kodunu ilgilendiren ayrıntılar için de makul varsayılan
seçilir ve raporda belirtilir; tekrar onay sorulmaz. M3 güvenlik kararları ise
ayrı plan adımında seçenekleri, artıları ve eksileriyle sunulacaktır.
Donmuş doğrulama, imzalayan ve operatör kataloglarını değiştirmek ayrıca
onay ve sürüm notu gerektirir.
Her adım raporundan sonra push kullanıcı tarafından yapılır. Rapor verilmeden
üçten fazla yerel commit biriktirilmez; üçüncü commit noktasında rapor verilir.

## Bu adımda seçilen ayrıntılar

- Metadata testleri, beş kontrol katmanını ayrı senaryolar olarak tutar.
  Her iki profilde her katmanın pozitif ve negatif örnekleri bulunur.
  Bir katmanı geçmek tam doğrulanmış istek sonucu değildir.
  Kaynak: [metadata fixture'ları](../tests/fixtures/metadata/cases.json).
- Thumbprint biçim hataları yalnızca ihlal edilen sabit kural metnini gösterir;
  sağlanan anahtar kimliği veya nonce hata mesajına yazılmaz.
  Kaynak: [metadata kontrolleri](../packages/core/src/profiles/metadata.ts).
- RFC B.2.6 smoke betiği, çalışma dizininden bağımsız fixture yolları ve
  derlenmiş ESM motor girişi kullanır. Paket kurulumu veya ağ erişimi yapmaz.
  Derleme ön koşuldur. Kullanıcı 2026-09-18 tarihinde smoke sonucunu başarılı
  olarak bildirdi: RFC B.2.6'nın 64 imza baytı birebir eşleşti.
  Kaynak: [20 satırlık smoke betiği](../scripts/smoke-core.mjs).
- WG bildirim metni yalnızca taslak olarak saklanır ve adım raporunda
  İngilizce paylaşılır; otomatik issue veya e-posta gönderilmez.
  Kaynak: [WG E.2.1 raporu](wg-e2-1-report-draft.md).
- Toplu doğrulama başarısızlığının özet nedeni, başlık sırasındaki ilk başarısız
  adaydan alınır; bütün aday sonuçları ayrıca korunur. Bu teşhis seçimi
  exactly-one/all/any kabul kurallarını veya aday sayımını değiştirmez.
  Varsayılan çoklu aday belirsizlik reddi bu özetleme kuralından önce gelir.
- Başarı kimlikleri aday sonuçlarında tutulur; çoklu başarıdan tek bir
  operatör veya URL kimliği seçilmez. Başarısız üst sonuç, başarılı bir
  alt adayın kimliğini üst düzey doğrulanmış kimlik olarak taşımaz.
- Başarı özet nedeni korumacı biçimde seçilir: başarılı adaylardan herhangi
  biri nonce'suz ise özet nonce'suz başarıyı belirtir. Her adayın replay
  koruması ayrıca raporlanır; özet kabul politikasını değiştirmez.
- Profil API'si @agentsig/core/profiles alt yolunda sunulur; saf motorun
  ana girişi korunur. İç aday değerlendirmesi, işlem tanıtıcıları ve bağlam
  yetkileri dışa aktarılmaz. Yeni paket veya çalışma zamanı bağımlılığı eklenmez.
- Gönderim öncesi zaman kontrolü ve onaylı saklama formülü aynı sağlıklı
  saat örneğine bağlanır. Bunun için yalnızca iç koordinatörde senkron
  hazırlık yolu kullanılır; dış replay depo sözleşmesi değişmez.
  Kaynak: [gönderim-anı testleri](../packages/core/test/profile-consume-preparation.test.ts).

## Ertelenen özellikler

- Ağdan anahtar dizini keşfi, SSRF/DNS koruması, ağ önbelleği ve otomatik
  yenileme M2 dışında kalır; güvenlik kararları ilgili kilometre taşında alınır.
- Zincirli imza kapsamı M2 dışında kalır. Proxy arkası dağıtımda ihtiyaç
  doğarsa ayrı bir kilometre taşıyla ele alınır.
- İmzalayanda mevcut imza başlıklarını birleştirme ve uzak/asenkron imza
  sağlayıcıları ertelenmiştir.
- Redis adaptörü ve dağıtık dönem/sıfırlama protokolü uygulanmamıştır.
  Bağımsız depo beyanı, uzak işlemleri iptal etme garantisi değildir.
- Gövde digest doğrulaması, framework adaptörleri, fetch katmanı ve CLI
  M2 uygulamasına sessizce dahil edilmeyecektir.

## Tamamlanan yerel kabul kapıları

- Çevrimdışı doğrulayıcı metadata, anahtar, kripto, zaman, replay ve
  çoklu aday kararlarını birleştirir. Belirsizlikte tüketim yapılmaması,
  ortak nonce grubu, tümü/herhangi biri politikaları ve sıfırlama yarışları
  gerçek doğrulayıcı üzerinden sınanmıştır.
- İki profilin dört golden imzalayan çıktısı tam doğrulayıcıdan doğrulanmış
  sonuç almıştır; ikinci kullanım replay reddi üretir. Her profil için
  100 eşzamanlı aynı istekte bir kabul ve 99 replay reddi gözlenmiştir.
  Saf kripto başarısı bu kabul kapısının yerine sayılmamıştır.
- Profil ESM/CJS dışa aktarımları, ayrı süreçlerde çalışma zamanı ve her iki
  biçimin tip bildirimi tüketici testleri geçmiştir.
- Son tam yerel kontrol: 4.284 birim testi, 13 entegrasyon testi, derleme ve
  tip denetimleri başarılıdır. Bağımsız M1 audit'i ve 60 ek fixture denetimi
  ayrıca geçmiştir. Bunlar Windows / Node 22 yerel sonuçlarıdır.

## Kullanıcı tarafından teyit edilen M2 teslimi

- Kullanıcı e8ecb27 ve 88e1fc0 commit'lerini push ettiğini, core-m2 etiketi
  oluşturduğunu ve CI/fixture workflow'larının yeşil olduğunu bildirdi.
- Kullanıcı 08592a2 smoke betiğini iki profilde başarıyla çalıştırıp push etti.
  İlk kabul, replay reddi ve süresi geçmiş imza reddi doğrulandı; M2 kabul edildi.
  Kaynak: [smoke betiği](../scripts/smoke-verify.mjs).
- Smoke yaş senaryosu varsayılanları değiştirmez: on dakika eski saat ve
  60 saniye ömürle yeniden imzalama, yaş kontrolünden önce sona erme reddi verir.
  Yaş sınırları ayrıca birim testlerindedir.

## 0.1.0 erken yayın hazırlığı

- İki paket için minor changeset 17b98d3 commit'ine kaydedildi; Changesets
  sürümleme işlemiyle tüketilerek paket sürümleri 0.1.0 ve changelog'lar üretildi.
  Yeni bir sürüm artışı gerekmiyorsa aynı changeset tekrar oluşturulmamalıdır.
- “Pre-release” README'lerde olgunluk uyarısıdır. İstenen 0.1.0 sürümü SemVer
  prerelease son eki taşımaz; npm yayını veya dağıtım etiketi oluşturulmadı.
- Doğrudan npm paketleme/yayınlama workspace protokolünü dönüştürmediğinden,
  core'un Structured Fields bağımlılığı tam 0.1.0 olarak sabitlendi.
  pnpm workspace bağlantısı açıkça etkinleştirildi; kilit dosyası yerel bağlantıyı
  korur. Sonraki sürümlemelerde bağımlılık ve kilit dosyası birlikte denetlenmelidir.
- Kök ve iki paket README'sinde durum bandı, yayın sonrası kurulum bilgisi ve
  10 satırlık ESM örneği bulunur. Structured Fields bandının proje kapsamını
  anlattığı, paketin kendi başına doğrulayıcı olmadığı ayrıca açıklanır.
- Dışa aktarım ve tip yolları korunmuştur. Paket içerik listesi yalnızca derleme
  çıktıları, README ve lisansa izin verir; npm manifesti otomatik dahil edilir.
  Changelog'lar depoda kalır; testler ve kamuya açık özel test anahtarları dağıtılmaz.
- Bu hazırlıkta kilitli çevrimdışı kurulum, derleme, tip denetimi,
  4.284 birim testi ve 13 entegrasyon testi yerelde geçti.
- npm paketleme önizlemesi: Structured Fields 7 dosya, 21,1 kB / 80,2 kB;
  core 14 dosya, 76,7 kB / 346,4 kB (sıkıştırılmış / açılmış).
  Kaynak, test ve fixture dosyaları listede yoktur. Önizleme yayın değildir.
- Elle yayın ileride kullanıcıya aittir; önce Structured Fields 0.1.0,
  sonra ona bağımlı core 0.1.0 yayımlanmalıdır. Yayın otomasyonu eklenmedi.

## Bekleyen teslim ve haricî doğrulamalar

- Yayın hazırlığı commit'lerinin kullanıcı tarafından push edilmesi ve yeni
  uzak CI sonucu. M2'nin yeşil sonucu yeni değişikliklere genellenmez.
- M3 planı bu adımda hazırlanmaz; kullanıcı push teyidinden sonra ayrı adımda
  güvenlik seçenekleri sunulur, sessiz varsayılan veya uygulama eklenmez.
- Asistan push, paket yayını veya WG bildirimi yapmaz. Kullanıcı WG bildirimini
  göndereceğini belirtti; gönderimin tamamlandığı henüz teyit edilmedi.
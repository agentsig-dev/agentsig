# Ertelenen işler ve güvenlik dışı uygulama seçimleri

Tarih: 2026-09-18. Bu kayıt, onaylanmış güvenlik sözleşmelerini değiştirmez.

## Karar alma sınırı

Kullanıcı talimatı: doğrulayıcının yanlış doğrulanmış sonuç üretmesini
etkilemeyen ayrıntılarda makul varsayılan seçilir, burada kaydedilir ve
yeniden onay sorulmaz. Yanlış kabulü etkileyen belirsizliklerde onay alınır.
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

## Bekleyen teslim ve haricî doğrulamalar

- Yeni değişiklikler için uzak CI matrisi; kullanıcı 6285514'e kadar 19
  commit'i push ettiğini ve Build and test #5 ile Fixture integrity #5'in
  yeşil olduğunu bildirdi. Bu başarı sonraki değişikliklere genellenmez.
- Sonraki yerel commit'lerin kullanıcı tarafından push edilmesi.
  Asistan push, paket yayını veya WG bildirimi yapmaz. Kullanıcı WG bildirimini
  göndereceğini belirtti; gönderimin tamamlandığı henüz teyit edilmedi.
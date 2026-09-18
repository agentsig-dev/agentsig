# Ertelenen işler ve güvenlik dışı uygulama seçimleri

Tarih: 2026-09-18. Bu kayıt, onaylanmış güvenlik sözleşmelerini değiştirmez.

## Karar alma sınırı

Kullanıcı talimatı: doğrulayıcının yanlış doğrulanmış sonuç üretmesini
etkilemeyen ayrıntılarda makul varsayılan seçilir, burada kaydedilir ve
yeniden onay sorulmaz. Yanlış kabulü etkileyen belirsizliklerde onay alınır.
Donmuş doğrulama, imzalayan ve operatör kataloglarını değiştirmek ayrıca
onay ve sürüm notu gerektirir.

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
  Derleme ön koşuldur; çalıştırma kullanıcıya bırakılmıştır.
  Kaynak: [20 satırlık smoke betiği](../scripts/smoke-core.mjs).
- WG bildirim metni yalnızca taslak olarak saklanır ve adım raporunda
  İngilizce paylaşılır; otomatik issue veya e-posta gönderilmez.
  Kaynak: [WG E.2.1 raporu](wg-e2-1-report-draft.md).

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

## Tamamlanmamış kabul kapıları

- Çevrimdışı doğrulayıcının metadata, anahtar, kripto, zaman, replay ve
  çoklu aday kararlarını birleştirmesi.
- İki profil imzalayanının çıktılarının tam doğrulayıcıdan doğrulanmış
  sonuç aldığı round-trip testleri. Saf kripto başarısı bunların yerine geçmez.
- Profil ESM/CJS dışa aktarımları ve gerçek tüketici testleri.
- Güncel yerel commit'ler için uzak CI matrisi; önceki CI başarısı yeni
  değişikliklere genellenmez.
- Kullanıcının smoke betiğini çalıştırması ve yerel commit'leri push etmesi.
  Asistan push, paket yayını veya WG bildirimi yapmaz.
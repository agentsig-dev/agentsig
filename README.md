# agentsig

> **Status: core engine only, pre-release, not security-reviewed**

Node.js için açık kaynak HTTP Message Signatures ve Web Bot Auth araç takımı.

**Mevcut teslimat:** profilden bağımsız RFC 9421 + Ed25519 motoru ve ayrı RFC 9651
Structured Fields paketi. Web Bot Auth profilleri ve framework adaptörleri henüz
uygulanmamıştır. Proje güvenlik denetiminden geçmiş değildir; resmî IETF veya
Cloudflare referans uygulaması/onayı iddia edilmez.

GitHub: https://github.com/agentsig-dev/agentsig
npm organizasyonu: **agentsig** (GitHub organizasyonu: **agentsig-dev**).

## Kısa yol haritası

- **M1 — mevcut:** RFC 9421 + Ed25519 motoru, ayrı Structured Fields paketi ve bağımsız fixture denetimi. Kullanıcı tarafından push edilen **core-m1** etiketi için CI matrisi yeşil olarak doğrulandı.
- **M2 — öneri, onay bekliyor:** iki sabit profil, zaman politikası, replay deposu ve elle verilen JWKS ile çevrimdışı doğrulama. [M2 planı](docs/milestone-2-plan.md).
- **Daha sonra:** güvenli dizin fetch/cache, istemci sarmalayıcısı, framework adaptörleri ve CLI; her aşama ayrı onaya tabidir.

**Profil, ağ, zaman/replay, adaptör ve CLI katmanları henüz yoktur.**
Planın belgelenmesi bu katmanların uygulandığı veya uygulama onayının alındığı anlamına gelmez.

## Neden bu kütüphane?

Node ekosisteminde HTTP imza motorları ve Web Bot Auth paketleri zaten var.
agentsig'in hedefi, kaynaklı uyumluluk testleriyle birlikte sürümü sabit profiller,
açık güven sınırları, güvenli anahtar keşfi, replay kontrolü ve framework
adaptörlerini aynı araç takımında sunmaktır. Bu hedeflerin tamamı bugün
uygulanmış değildir.

[Kaynaklı paket karşılaştırması ve tasarım kararları](docs/core-api-proposal.md)
alternatifleri ve incelenen sürümlerin sınırlarını açıklar. Paket karşılaştırması
güvenlik denetimi veya performans üstünlüğü kanıtı değildir.

## Neden stealth değil?

agentsig kimliğini açıklayan istemciler için imzalama ve doğrulama altyapısıdır.
Tarayıcı parmak izi değiştirmez, CAPTCHA çözmez, bot tespitini atlatmaz ve
erişim kurallarını aşmaz. Geçerli imza iyi niyeti, gerçek dünyadaki operatör
kimliğini veya erişim yetkisini tek başına kanıtlamaz.

Kriptografik doğrulama, yalnızca seçilen anahtarın kapsanan bileşenlere ait
imzayı doğruladığını gösterir. Anahtarı bir ajana/operatöre bağlamak, kapsamı
yeterli bulmak ve isteğe izin vermek ayrı kararlardır.

## Rate limit ile farkı

İmza doğrulaması "hangi anahtar bu veriyi imzalamış?" sorusunu yanıtlar.
Rate limit ise "bu kimlik/istemci ne sıklıkla işlem yapabilir?" politikasını
uygular. Geçerli imza hız sınırından muafiyet sağlamaz; ikisi birlikte kullanılır.
Kısa imza ömrü replay penceresini daraltır, tek başına tekrar kullanımını önlemez.
Nonce deposu ve saat politikası bu ilk motor teslimatında bulunmaz.

## Paketler

| Paket | Durum |
| --- | --- |
| @agentsig/structured-fields | Kayıpsız ham AST, anlamsal model, RFC 9651 parser/serializer ve kaynak limitleri |
| @agentsig/core | RFC 9421 ayrıştırma, imza tabanı, Ed25519 imzalama ve kriptografik doğrulama |
| @agentsig/fetch | Planlandı; bu teslimatta yok |
| @agentsig/hono | Planlandı; bu teslimatta yok |
| @agentsig/fastify | Planlandı; bu teslimatta yok |
| @agentsig/express | Planlandı; bu teslimatta yok |
| agentsig — CLI | Planlandı; bu teslimatta yok |

[Core API ve güven sınırı](packages/core/README.md) ·
[Structured Fields API ve bütçeler](packages/structured-fields/README.md)

İki mevcut paket ESM/CJS ve ilgili tip bildirimlerini üretir; Node 20+ çalışma
zamanını hedefler. Üretimde güvenlik güncellemeleri alan bir Node sürümü kullanın.
Geliştirme araçları Node 20.19+ veya 22.12+ gerektirir; Node 24 de hedeflenir.
Çalışma zamanı sürüm desteği, EOL sürümler için güvenlik desteği vaadi değildir.

## Yerel geliştirme

pnpm 10.12.1 kullanılır. Depo kökünde sırasıyla:
1. Bağımlılıkları yükleyin: pnpm install --frozen-lockfile --ignore-scripts
2. Tam kontrolü çalıştırın: pnpm run check

Komutlar [workspace manifestinde](package.json) tanımlıdır:
- Tam kontrol: derleme → tip kontrolü → birim/golden/property testleri → tüketici/fixture testleri.
- Birim testleri: pnpm run test:unit
- Motordan bağımsız RFC ↔ fixture ↔ kripto denetimi: pnpm run audit:fixtures
- Yalnızca fixture bütünlüğü: pnpm run test:fixtures
- Geliştirme sırasında test izleme: pnpm run test:watch
- Sürüm değişikliği kaydı: pnpm changeset

Core, derlenmiş SF workspace paketini tüketir. Temiz checkout'ta yalnızca birim
testi veya tip kontrolü çalıştırmadan önce pnpm run build çalıştırılmalıdır.
Kurulum paket yayınlamaz; otomatik yayınlama veya release workflow'u yoktur.

## Test yaklaşımı

- RFC 9421 B.1.4 anahtarı ve B.2.6 imza baytları uygulamadan önce ayrı commit'e alındı.
- Ayrıştırma, imza tabanı, imzalama ve doğrulama dört bağımsız golden takımında sınanır.
- İmzalayıcı yayımlanmış imza baytlarını birebir üretir; doğrulayıcı kendi imzalayıcımızın çıktısına dayanmaz.
- HTTP WG SF takımı sabit commit'ten alınır; Date, Display String ve ondalık ayrımı korunur.
- Fuzz/property testleri sabit tohumlarla tekrar üretilebilir.
- Fixture'lar bayt olarak okunur; Git satır sonu ayarları yalıtılmış depolarda gerçek add/checkout işlemleriyle sınanır.
- ESM/CJS tüketicileri derlenmiş paketleri gerçek paket adlarıyla yükler.

[Fixture kaynakları, commit ve lisans atıfları](docs/fixture-provenance.md) ·
[CI matrisi](.github/workflows/ci.yml)

CI hedefi Node 20/22/24 × Windows/Linux'tur. Kullanıcı **core-m1** için matrisi
yeşil olarak doğrulamıştır. Daha sonraki yerel değişiklikler için bu sonuç
devralınmaz; her commit'in uzak CI sonucu ayrı değerlendirilir.
[Fixture workflow'u](.github/workflows/fixtures.yml) tüm PR'larda bağımsız audit
ve bayt bütünlüğü kontrollerini çalıştırır; fixture dizinlerini değiştiren PR'lar
dahil hiçbir PR yol filtresiyle atlanmaz. Tarihsel fixture commit'ini incelemek
için tam Git geçmişi alınır; audit bağımlılık kurulumu veya motor derlemesi gerektirmez.

## Protocol compatibility

Aşağıdaki tablo **gelecek profil katmanının kaynak sabitlemesidir**; mevcut
core motoru bu profilleri doğruladığını veya Cloudflare'de kabul edildiğini
iddia etmez.

Planlanan profiller:
- Varsayılan IETF WG protocol-00: 1 Eylül 2026 tarihli taslak.
- Açıkça seçilen Cloudflare doküman profili: sayfadaki son güncelleme 1 Temmuz 2026.
- Erişim tarihi: 18 Eylül 2026. Cloudflare kaynağının değişmez snapshot'ı profil
  uygulamasından önce ayrıca sabitlenecek.
- İmzalayan otomatik downgrade/sessiz yeniden deneme yapmayacak.
- Doğrulayıcı kullanılan profili sonuçta bildirecek; kabul politikasını uygulama belirleyecek.

| Konu | WG protocol-00 | Cloudflare dokümanı | Satır kaynakları |
| --- | --- | --- | --- |
| Signature-Agent biçimi | Dictionary üyesi | Tırnaklı Structured String; Dictionary biçimi reddediliyor | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1), [CF §4.3; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| İmza kapsamındaki ajan bilgisi | İlgili Dictionary üyesi | Başlığın tamamı kapsanmalı | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1), [CF §4.3; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Hedef bileşeni | Authority veya target URI bileşenlerinden en az biri zorunlu | En az authority öneriliyor | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.1; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#41-choose-a-set-of-components-to-sign) |
| Nonce | Ek zorunluluk yok | Öneriliyor; tekrar deposuyla doğrulanmadığı belirtiliyor | [WG §5.2.3](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.3), [CF §4.3; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Ömür | En fazla 24 saat öneriliyor | Kısa ömür; bir dakika çoğunlukla yeterli | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.3; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Dizin yanıt imzası | Temel URL kimliği için Ek B atlanabilir; kanıt için authority ve content-digest kapsanır | Kullanılacak her anahtar için yanıt imzası isteniyor | [WG Ek B](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#appendix-B), [CF §2; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#2-host-a-key-directory) |
| Anahtar kimliği | Base64url SHA-256 JWK thumbprint | JWK thumbprint | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.2; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#42-calculate-the-jwk-thumbprint) |
| Yetki / Verified Bot statüsü | İmza tek başına yetkilendirme veya operatör itibarı sağlamaz | Kayıt ve onay süreci ayrıca gerekiyor | [WG §4](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-4), [CF §3; 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#3-register-your-bot-and-key-directory) |

Cloudflare araştırma sunucusu, üretim Verified Bots hizmeti ve güncel WG taslağı
ayrı uyumluluk hedefleridir. Örnek dokümandaki temsili imzalar kriptografik golden
vektör olarak kullanılmaz. Canlı Cloudflare testi bu teslimatta çalıştırılmadı.

## Güvenlik ve yayın

Üretimde yayımlanmış RFC özel anahtarlarını kullanmayın. Geçerli kriptografik
sonucu tam kimlik doğrulaması yerine koymayın. Trailer, Ed25519 dışı algoritmalar
ve bilinmeyen bileşenler sessizce atlanmaz; destek sınırları paket belgelerinde açıklanır.

Yayınlama kullanıcı tarafından ayrıca onaylandıktan sonra elle yapılacaktır.
Bu teslimat hiçbir npm paketi yayınlamaz ve uzak depoya push yapmaz.

## Lisans

Proje kodu [MIT](LICENSE). RFC ve HTTP WG test verileri kendi telif/lisans
bildirimlerini korur; ayrıntılar [fixture kaynak kaydında](docs/fixture-provenance.md).
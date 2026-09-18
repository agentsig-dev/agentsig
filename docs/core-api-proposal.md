# agentsig — core API önerisi
Durum: ilk motor kilometre taşı uygulandı (core-m1); aşağıdaki ilk öneri tarihsel tasarım kaydıdır. Güncel API karşılaştırması §11'dedir. M2 yalnızca [onay bekleyen plan](milestone-2-plan.md) aşamasındadır. İnceleme tarihi: 2026-09-18.

## Uygulama onayı — 2026-09-18
Bu bölüm, aşağıdaki ilk önerilerle çelişen noktalarda önceliklidir.
- İlk core kilometre taşı, kendi Structured Fields ayrıştırıcımız dahil kullanıcı tarafından onaylandı.
- GitHub deposu: https://github.com/agentsig-dev/agentsig. npm organizasyonu ve paket adları değişmedi.
- Ayrıştırıcı ayrı workspace paketi: @agentsig/structured-fields. @agentsig/core bu pakete bağımlıdır; SF paketi core'a bağımlı değildir.
- Ham AST, standart anlamsal model, kaynak limitleri, RFC 9651 parser/serializer ve fuzz/property testleri SF paketinde bulunur.
- Uygulama sırası: geliştirme altyapısı → kaynak fixture'ları ve ayrı fixture commit'i → SF paketi → core motoru.
- Herhangi bir kütüphane uygulama kodundan önce RFC 9421 B.1.4 anahtarı, B.2.6 imza tabanı/imza baytları ve HTTP WG Structured Fields test takımı repoya alınır.
- Fixture kaynakları sürüm, upstream commit (varsa), içerik özeti ve lisans atıflarıyla sabitlenir. RFC için olmayan bir Git commit'i uydurulmaz; RFC numarası/bölümü ve kaynak içerik özeti kullanılır.
- Testler fixture dosyalarını bayt olarak okur. Kanonik fixture metinlerine otomatik trim, satır sonu normalizasyonu veya son LF ekleme uygulanmaz.
- Git attributes metin fixture/golden dosyalarında LF zorlar; ikili fixture'lar metin dönüşümünden muaf tutulur.
- Satır sonu kontrolü geçici, yalıtılmış Git deposunda otomatik dönüşüm ayarlarıyla gerçek add/checkout akışını sınar; kullanıcının global Git ayarları değiştirilmez.
- Altyapı, fixture, SF ve motor sonunda kısa rapor verilir: tamamlanan işler, gerçekten çalıştırılmış testlerin sonuçları ve onay bekleyen kararlar.
- CI hedefi Node 20/22/24 × Windows/Linux; yerel çalıştırma sonuçları CI'da henüz çalışmamış sonuçlardan ayrılır.
- İlk teslimatta profil katmanı, ağ erişimi, nonce deposu, framework adaptörleri ve CLI uygulanmaz. Paket yayını ve uzak depoya push yapılmaz.

## 1. Kararlaştırılmış sınırlar
- Paketler: @agentsig/core, @agentsig/fetch, @agentsig/hono, @agentsig/fastify, @agentsig/express; CLI: agentsig.
- İlk kilometre taşı: profilden bağımsız RFC 9421 kanonikleştirme ve Ed25519 imzalama/doğrulama, golden ve negatif testlerle.
- Sonraki katman: sürümü sabit iki profil; IETF varsayılan, Cloudflare açıkça seçilir.
- İmzalayan otomatik downgrade veya sessiz yeniden deneme yapmaz.
- Doğrulayan iki formatı tanır, seçilen profili raporlar; uygulama politikası profili reddedebilir.
- Nonce tekrar kontrolü her iki profilde varsayılan zorunlu, varsayılan depo bellek içidir. İsteğe bağlı politika bilinçli seçilebilir; korumasız başarı açıkça raporlanır.
- Profil başına yapılandırılabilir varsayılanlar: imzalama 60 sn, azami ömür ve yaş 300 sn, saat toleransı 30 sn.
- TypeScript; ESM ve CJS; Node 20+ hedefi; pnpm workspaces, changesets, vitest, MIT.
- Kriptografi Node yerleşik crypto modülünden; dış kripto bağımlılığı yok.
- Yayınlama yapılmaz; elle yayınlama kullanıcıya aittir.

## 2. Paket sınırları
| Paket | Sorumluluk | Sınır |
| --- | --- | --- |
| @agentsig/core | RFC 9421 motoru; sonraki aşamada profiller, JWK/thumbprint, dizin, cache, replay ve doğrulama politikası | Framework bağımlılığı ve otomatik yetkilendirme yok |
| @agentsig/fetch | İstekleri gönderimden önce imzalayan fetch sarmalayıcısı; anahtar seçimi ve açık profil | Redirect/retry sessizce imzayı başka hedefe taşımaz; her yeni gönderim ayrı değerlendirilir |
| @agentsig/hono | Hono istek eşlemesi, doğrulama sonucu ve politika hook'u | Kripto ve keşif kodunu tekrarlamaz |
| @agentsig/fastify | Fastify hook, request decoration ve politika hook'u | Proxy güvenini kendiliğinden genişletmez |
| @agentsig/express | Express middleware, request context ve politika hook'u | Orijinal istek hedefini router yeniden yazımlarından önce yakalar |
| agentsig | Anahtar üretimi, dizin çıktısı, imzalı test isteği, güvenli debug | Gizli anahtarı loglamaz; otomatik npm yayını yok |

Bağımlılık yönü: adaptörler ve fetch → core; CLI → core ve fetch. Core hiçbir adaptöre bağımlı değildir.
Dizin oluşturma ve yanıt imzalama core'da ortak kalır; fetch paketi kolaylık dışa aktarımı sunabilir.
Core'un saf motoru ile Node ağ erişimi kullanan dizin modülü ayrı alt giriş noktalarında tutulmalıdır.
Operatör adı, kriptografiden türetilmez; doğrulanmış kimliği operatöre eşleyen uygulama hook'u tarafından sağlanır.

## 3. İlk kilometre taşı: tip düzeyindeki API
Aşağıdaki bildirimler tarihsel öneridir; doğrudan güncel API referansı değildir. Uygulanan tipler ve gerekçeli farklar §11'de karşılaştırılır.
Başlıklar sıralı çiftlerdir: tekrarları korur; yalnızca Headers veya Record kullanımı zorunlu değildir.
URI girdisi HTTP mesajının dışarıdan görülen hedefidir; imzalanmadan önce rastgele URL normalizasyonu yapılmaz.
Motor Forwarded/X-Forwarded-* başlıklarına kendiliğinden güvenmez.

```ts
import type { KeyObject } from "node:crypto";

export type HeaderField = readonly [name: string, value: string];
export type HeaderFields = readonly HeaderField[];
export type SfBare =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "decimal"; readonly thousandths: number }
  | { readonly kind: "date"; readonly epochSeconds: number }
  | { readonly kind: "display-string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "bytes"; readonly value: Uint8Array };
export type SfParameter = readonly [name: string, value: SfBare];
export type Parameters = readonly SfParameter[];

export interface RequestParts {
  readonly method: string;
  readonly targetUri: string;
  readonly rawRequestTarget?: string;
  readonly headers: HeaderFields;
}
export type HttpMessage =
  | { readonly kind: "request"; readonly request: RequestParts }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers: HeaderFields;
      readonly request?: RequestParts;
    };
export interface CoveredComponent {
  readonly name: string;
  readonly parameters: Parameters;
}
export interface SignatureInput {
  readonly label: string;
  readonly components: readonly CoveredComponent[];
  readonly parameters: Parameters;
}
export interface ParsedSignature {
  readonly input: SignatureInput;
  readonly signature: Uint8Array;
}
export interface Limits {
  readonly maxSignatureHeaderBytes: number;
  readonly maxSignatures: number;
  readonly maxComponentsPerSignature: number;
  readonly maxParameters: number;
}
export interface CanonicalizationOptions {
  readonly structuredFieldTypes?: Readonly<Record<string, "item" | "list" | "dictionary">>;
}
export interface SignatureBase {
  readonly text: string;
  readonly bytes: Uint8Array;
}
export interface SignatureHeaderPatch {
  readonly label: string;
  readonly signatureInput: string;
  readonly signature: string;
}
export type CryptoVerification =
  | { readonly status: "signature-valid"; readonly input: SignatureInput }
  | {
      readonly status: "rejected";
      readonly reason: "malformed" | "unsupported" | "missing-component" | "invalid-key" | "signature-mismatch";
    };

export declare function parseSignatureHeaders(
  headers: HeaderFields,
  limits: Limits,
): readonly ParsedSignature[];
export declare function createSignatureBase(
  message: HttpMessage,
  input: SignatureInput,
  options?: CanonicalizationOptions,
): SignatureBase;
export declare function signHttpMessage(
  message: HttpMessage,
  input: SignatureInput,
  privateKey: KeyObject,
  options?: CanonicalizationOptions,
): Promise<SignatureHeaderPatch>;
export declare function verifyHttpSignatureCryptography(
  message: HttpMessage,
  signature: ParsedSignature,
  publicKey: KeyObject,
  options?: CanonicalizationOptions,
): Promise<CryptoVerification>;
```

### Motor sözleşmesi
- Parametreler nesne alanları olarak yeniden sıralanmaz; bileşen ve parametre sırası korunur.
- Ham ayrıştırma katmanı parametre tekrarlarını ve konumlarını korur. RFC'nin anlamsal tekrar çözümlemesi ayrı uygulanır; ham tekrarların tamamı körlemesine imza tabanına yazılmaz.
- İmza başlıklarındaki tekrar/çakışma kuralları RFC 9421 ve Structured Fields kurallarına göre test edilir; daha sıkı yerel ret kuralları varsa ayrıca belgelenir.
- Ham istek hedefi gerektiren bileşen, bu bağlam yoksa tahmin edilmez ve reddedilir. Mutlak hedef URI ile ham hedef arasındaki tutarlılık adaptör sözleşmesidir.
- Structured Fields ayrıştırılır ve RFC kurallarıyla serileştirilir; regex/split tabanlı bir parser yeterli değildir.
- Sayı aralıkları, ASCII, anahtar türü ve Ed25519 eğrisi çalışma zamanında doğrulanır.
- Ed25519 dışında anahtar reddedilir; mesaj üzerinde ayrıca SHA-256 ön-hash uygulanmaz.
- İmza tabanı RFC 9421 biçiminde ve UTF-8 baytlarına dönüştürülür; fazladan son satır sonu eklenmez.
- Response içindeki istek referanslı bileşenler için ilgili request bağlamı zorunludur.
- Başlık patch'i tek label içindir; mevcut imza başlıklarını sessizce ezmez. Birleştirme ayrıca açıkça yapılır.
- Saf motor zaman, nonce, dizin veya yetkilendirme kontrolü yapmaz. signature-valid bir Web Bot Auth verified sonucu değildir.
- Parser/kanonikleştirme hataları kararlı kodlara sahip tipli hatalardır; beklenen doğrulama retleri sonuç olarak döner.
- Desteklenmeyen bileşen/parametre sessizce atlanmaz. Trailer desteği ilk aşamada yoktur; kullanımı açıkça reddedilir.
- Structured Fields altyapısı RFC 9651 Date ve Display String dahil kayıpsız türleri destekler. RFC 9421'in RFC 8941'e dayanan imza alanları için kabul edilen türler ayrıca sınırlandırılır; yeni türleri desteklemek her alanda kabul etmek anlamına gelmez.
- Ondalıklar binlik ölçekli tamsayı olarak tutulur: tamsayı/ondalık ayrımı kaybolmaz ve ikili kayan nokta yuvarlaması kanonik baytları değiştirmez. Ölçek ve RFC aralıkları doğrulanır.

## 4. Profil katmanı: önerilen sözleşmeler
Profil adları için öneri: ietf-wg-protocol-00 ve cloudflare-docs-2026-07-01.
İkinci ad Cloudflare'in kendi sürüm numarası değil, agentsig'in sabitlediği doküman profilinin adıdır.
Protokol değişikliği yeni profil gerektirir. Hata ve güvenlik düzeltmeleri ise sürüm notlarıyla yapılır; güvensiz uygulama davranışı dondurulmaz.
Doğrulayıcı biçim sınıflandırması ardından ilgili profil kurallarını uygular; başarısızlığı başka profili deneyerek başarıya çevirmeye çalışmaz.
Bir istekte farklı profillere ait bağımsız imzalar bulunabilir; sonuç label başına üretilir, kabul kuralını uygulama seçer.

```ts
export type ProfileId = "ietf-wg-protocol-00" | "cloudflare-docs-2026-07-01";
export interface TimePolicy {
  readonly signingLifetimeSeconds: number;
  readonly maxLifetimeSeconds: number;
  readonly maxAgeSeconds: number;
  readonly clockSkewSeconds: number;
}
export type NoncePolicy = "required" | "optional";
export type ReplayProtection =
  | { readonly replayProtected: true; readonly replayReason: "nonce-consumed" }
  | { readonly replayProtected: false; readonly replayReason: "nonce-absent-optional" };
export interface ReplayStore {
  consume(input: {
    readonly scope: string;
    readonly keyId: string;
    readonly nonce: string;
    readonly retainUntilEpochSeconds: number;
  }): Promise<"accepted" | "replayed" | "unavailable">;
}
export interface VerifiedIdentity {
  readonly keyId: string;
  readonly identifier:
    | { readonly kind: "directory-url"; readonly url: string }
    | { readonly kind: "key-thumbprint"; readonly thumbprint: string };
}
export type VerificationResult =
  | ({
      readonly status: "verified";
      readonly label: string;
      readonly profile: ProfileId;
      readonly identity: VerifiedIdentity;
    } & ReplayProtection)
  | { readonly status: "unsigned" }
  | {
      readonly status: "invalid" | "unverified";
      readonly label?: string;
      readonly profile?: ProfileId;
      readonly reason: string;
    };
```

Bu ikinci blok sözleşme yönünü gösterir; reason alanı uygulamadan önce kapalı hata kodları birliğine daraltılacaktır.
Dizin çözümleyicisi en az URL + keyid bağını korur; tüm set atomik yenilenir, eski setle birleşip kaldırılan anahtarları yaşatmaz.
Replay consume tek atomik işlem olmalıdır; kripto, kimlik bağlama ve zaman kontrollerinden sonra çalışır.
Replay scope doğrulayıcının yapılandırdığı güven alanıdır; istemcinin serbestçe değiştirebildiği URL/label tek başına scope olamaz.
Depo girdisi yapılandırılmış azami yaş + tolerans esas alınarak saklanır; sabit TTL kullanılmaz.
Önerilen güvenli üst sınır: saklama sonu = max(doğrulama anı, created) + maxAgeSeconds + clockSkewSeconds.
Bu seçim, gelecekte oluşturulmuş ancak tolerans içinde kabul edilmiş bir imzanın TTL dolduktan sonra yeniden kabul edilmesini önler.
Örneğin 300 sn azami yaş ve 30 sn toleransta oluşturulma zamanı 30 sn ilerideyse, ilk kabul anından 330 sn sonra kayıt silmek erken olabilir; üst sınır 360 sn olur.
Bu TTL ayrıntısı profil aşamasında zaman kabul eşitsizlikleri ve sınır testleriyle kesinleştirilir; kullanıcıya sabit 330 sn garantisi verilmez.
Dolu/erişilemez depo başarılı replay kontrolü sayılmaz. Optional politika yalnızca eksik nonce'u gevşetir; mevcut nonce'un tekrarını veya depo arızasını gizlemez.
Bellek içi depo süreçler arası koruma sağlamaz; çoklu instance için paylaşımlı atomik depo gerekir.
Kaynak hatası unverified olabilir; bu, erişim izni değildir. Politikayı uygulama uygular.

## 5. Güvenlik kararları ve ertelenen seçenekler
Nonce zorunluluğu ve dengeli zaman politikası kullanıcı tarafından onaylandı.
Structured Fields bağımlılığı kabul kriterleri onaylandı; inceleme sonucu §9'da.
Dizin erişimi ve bayat cache davranışları öneridir; ağ katmanının uygulamasından önce ayrıca onaylanacaktır.
| Karar | Öneri | Alternatif ve maliyeti |
| --- | --- | --- |
| Nonce eksikliği | Varsayılan zorunlu: nonce yoksa verified üretme | Varsa kontrol: eski istemcilerle daha uyumlu, ancak noncesiz istekte replay önlenmez; sonuç bunu belirtir |
| Dengeli zaman politikası | İmzalama 60 sn; azami ömür 300 sn; azami yaş 300 sn; tolerans 30 sn | Sıkı: aynı süreler, tolerans 5 sn; daha az replay payı, iyi saat senkronizasyonu gerekir |
| Geniş uyumluluk | Varsayılan yapma | İmzalama 60 sn; azami ömür/yaş 86400 sn; tolerans 60 sn; uzun imzaları kabul eder, nonce deposunu büyütür |
| Dizin erişimi | HTTPS, redirect yok, global yönlendirilebilir IP'ler; DNS sonucu bağlantıda sabitlenir | Önceden izinli origin listesi daha dar saldırı yüzeyi sağlar, açık keşfi sınırlar |
| Önbellek bayatlığı | Başarısız fetch kaydı silmez ama bayat kaydı otomatik güvenilir yapmaz | Sınırlı stale-if-error kullanılabilir; kaldırılmış anahtarın kabul süresini uzatır |
| Structured Fields | Küçük, denetlenebilir bağımlılık değerlendirmeye açık | Sıfır runtime bağımlılığı: kendi parser'ımız, daha yüksek test/fuzz ve bakım yükü |

Zaman değerleri iki profil için de onaylanmış başlangıç varsayılanlarıdır; profil başına ayrı değiştirilebilir ve protokol zorunluluğu değildir.
Nonce varlığı tek başına gövdeyi veya yolu bağlamaz. Yazma istekleri için yöntem, hedef ve doğrulanan Content-Digest kapsamı ayrıca tasarlanmalıdır.
SSRF korumasında yalnızca DNS ön kontrolü yeterli değildir: yeniden çözümleme, IPv6, IPv4-mapped IPv6, proxy ve bağlantı havuzu davranışları test edilmelidir.
Timeout, byte limiti, anahtar sayısı, cache kapasitesi ve eşzamanlı fetch limitleri dizin kilometre taşında ayrıca onaylanacaktır.

## 6. Protocol compatibility — satır bazlı kaynaklar
WG kaynak sürümü: draft-ietf-webbotauth-httpsig-protocol-00, 2026-09-01.
Cloudflare kaynağı: Web Bot Auth, sayfada görülen son güncelleme 2026-07-01; erişim 2026-09-18.
Cloudflare sayfası değişebilir; uygulama öncesi kaynak commit'i veya içerik özetiyle snapshot alınmalıdır.
| Konu | WG-00 | Cloudflare belgelenmiş profil | Kaynak |
| --- | --- | --- | --- |
| Signature-Agent biçimi | İmza etiketine bağlı Dictionary üyesi | Tırnaklı Structured String; Dictionary biçimi başarısızlık nedeni | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1); [CF §4.3, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| İmzalanan ajan bilgisi | İlgili Dictionary üyesi key parametresiyle kapsanır | Başlık bileşen listesinde bulunmalıdır | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1); [CF §4.3, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Hedef bileşeni | authority veya target-uri bileşenlerinden en az biri zorunlu | En az authority öneriliyor | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2); [CF §4.1, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#41-choose-a-set-of-components-to-sign) |
| Nonce | Ek nonce zorunluluğu tanımlanmıyor | Öneriliyor, ancak nonce doğrulaması/tekrar deposu olmadığı belirtiliyor | [WG §5.2.3](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.3); [CF §4.3, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| İmza ömrü | En fazla 24 saat öneriliyor | Kısa ömür; bir dakika çoğunlukla yeterli ifadesi var | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2); [CF §4.3, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Dizin yanıt imzası | Temel URL kimliği için Ek B atlanabilir; Ek B kanıtında istek authority'si ve content-digest kapsanır | Kullanılacak her anahtar için yanıt imzası isteniyor; gösterilen zorunlu bileşen tablosu authority'yi listeliyor | [WG Ek B](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#appendix-B); [CF §2, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#2-host-a-key-directory) |
| Anahtar kimliği | Base64url SHA-256 JWK thumbprint | JWK thumbprint kullanılıyor | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2); [CF §4.2, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#42-calculate-the-jwk-thumbprint) |
| Verified Bot statüsü | Yerel yetkilendirme/operatör itibarı protokolün kanıtladığı şey değildir | Kayıt ve başarılı doğrulama süreci ayrıca gerekiyor | [WG §4.1 ve §4.6](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-4); [CF §3, 2026-07-01](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#3-register-your-bot-and-key-directory) |

Bu tablo canlı Cloudflare hizmetinde yapılmış test sonucu değildir. Belge uyumluluğu ve canlı kabul ayrı raporlanacaktır.
Taslakta §5.5'in 200 zorunluluğu ile Ek C'nin koşullu HTTP cache önerileri; redirect hükümleri arasında da açıklığa kavuşturulacak ayrıntılar vardır. Sessiz yorum yapılmayacaktır.

## 7. İlk kilometre taşı kabul ölçütleri
- RFC 9421 Ed25519 örneği Appendix B.2.6 incelendi: beklenen imza tabanı ve gerçek imza baytları mevcut. §2–§3'ün her uygulanan kuralı kodlama sırasında ilgili alt bölümüyle eşlenir.
- Dört ayrı golden takımı oluşturulur: başlık → ayrıştırılmış yapı; mesaj → imza tabanı; sabit özel anahtar → beklenen imza başlıkları; yayımlanmış imza/açık anahtar → doğrulama sonucu.
- RFC 9421 B.1.4 anahtarı ve B.2.6 örneği kaynak atıflarıyla sabitlenir; testlerde RFC 8792 satır katlamaları kaldırılır. Motor saati kontrol etmediği için eski tarihli örnekler doğrudan doğrulanabilir.
- Header normalizasyonu, tekrar eden alanlar, OWS, boş değerler ve ASCII sınırları için bağımsız golden testler yazılır.
- authority, method, target-uri, scheme, request-target, path, query, query-param ve response status bileşenleri RFC kurallarıyla sınanır.
- sf, key, bs ve response-to-request req parametreleri; parametre sırası; signature-params satırı sınanır.
- Desteklenmeyen trailer ve parametre bileşimleri için açık ret testleri bulunur; tam RFC kapsamı iddiası yapılmaz.
- RFC Ed25519 vektörünün beklenen imza tabanı ve imza baytları sabit fixture olur; yalnızca kendi sign/verify round-trip testiyle yetinilmez.
- Yanlış anahtar, bozuk SF/base64, yanlış label eşlemesi, eksik bileşen, değiştirilmiş imza ve mesaj için negatif testler yazılır.
- Çoklu imza ayrıştırılır; her label bağımsız doğrulanır, ilk başarılı imza otomatik erişim iznine dönüşmez.
- URI percent-encoding, boş query, yinelenen query parametreleri, port ve authority köşe durumları test edilir.
- Kaynak fixture lisansları/atıfları korunur; güvenlik kararlarının gerekçeleri testlerde ve kod yorumlarında belirtilir.
- ESM ve CJS tüketici testleri, tip kontrolü ve Node sürüm matrisi çalışır; hiçbir paket yayınlanmaz.

## 8. Profil ve entegrasyon aşaması kabul ölçütleri
- WG ve Cloudflare fixture takımları ayrıdır; hangi kaynak sürümüne ait oldukları kayıtlıdır.
- Taslakta gerçek vektör bulunursa beklenen baytlar kullanılır; temsili imzalar kriptografik golden sayılmaz.
- Cloudflare örneklerinden birebir serileştirme fixture'ları ile gerçek anahtar kullanarak oluşturulan kriptografik fixture'lar ayrılır.
- Canlı test kullanıcı tarafından açıkça çalıştırılır; ağ hedefi ve gizli anahtar yapılandırması dışarıdan verilir.
- Replay için eşzamanlı iki istekte tek kabul, saat toleranslı TTL, kapasite ve depo arızası testleri bulunur.
- SSRF, DNS rebinding, cache yenileme, anahtar kaldırma ve çoklu süreç sınırları test edilir.
- Aşağıdaki paket karşılaştırması doküman ve seçili kaynak incelemesidir; paketlerde test çalıştırılmamış, güvenlik denetimi yapılmamıştır.
- WG eklerinin tümünde kriptografik vektör envanteri henüz çıkarılmadı; profil aşamasına geçiş koşuludur. Temsili örnekler gerçek vektör gibi raporlanmaz.

## 9. Kaynaklı paket karşılaştırması ve bağımlılık kararı
Erişim tarihi: 2026-09-18. Liste hedefli bir taramadır; tüm npm ekosisteminin eksiksiz envanteri değildir.
Sürümü sabit npm bağlantıları kullanılır; GitHub ana dalı incelemeleri değişmez yayın kanıtı sayılmaz.
| Paket / incelenen sürüm | Doğrulanmış belgelenen yetenek | Sınır / agentsig için kalan iş | Kaynak |
| --- | --- | --- | --- |
| http-message-sig 0.3.0 | RFC 9421 motoru, sıralı alan oluşumları, istek/yanıt bağlamı, Dictionary üyesi seçimi, çoklu imza, WebCrypto sağlayıcıları | Genel Structured Fields serileştirmesi, bayt biçimi, trailer seçimi ve tekil query-param açıkça reddediliyor; RFC 9651 yeni türleri imza alanlarında reddediliyor. Anahtar keşfi çağırana ait | [npm 0.3.0](https://www.npmjs.com/package/http-message-sig/v/0.3.0), Capabilities ve Limitations |
| web-bot-auth, depo rozeti 0.2.0 | Web Bot Auth imzalama/doğrulama politikası; Ed25519/RSA; Signature-Agent, registry ve ajan kartı ayrıştırma; çoklu label seçimi | Belgelenmiş hedef bireysel protocol-00, WG-00 ile eşit sayılmaz. Örnekte resolver ve atomik replay cache uygulamaya bırakılıyor. Hazır Hono/Fastify/Express adaptör seti incelenen belgede gösterilmiyor | [Cloudflare paket belgesi](https://github.com/cloudflare/web-bot-auth/tree/main/packages/web-bot-auth), Features, Verifying ve Security Considerations |
| http-message-signatures 1.0.6 | Node yerleşik kripto sağlayıcıları; RSA, ECDSA, Ed25519; genel imzalama/doğrulama; iki tarihsel HTTP imza biçimi | Belge taslak revizyon 13 hedefini bildiriyor; nihai RFC uyumu test edilmedi. Ham istek hedefi çıkarımı ve karmaşık mesaj bağlamlarında sınırlar belgelenmiş. Web Bot Auth profilleri bu incelemede doğrulanmadı | [npm 1.0.6](https://www.npmjs.com/package/http-message-signatures/v/1.0.6), Caveats, Limitations ve Examples |
| structured-headers, görünen son sürüm 2.1.0 | RFC 9651/8941; Date/Display String; TypeScript, ESM/CJS, sıfır bağımlılık beyanı; yakın tarihli bakım; resmî HTTP WG testlerinden yararlanma | Tamsayı değerli ondalıkların tür ayrımı ve bazı yuvarlamalar için açık serileştirme sınırlamaları var. Parametre tekrarları çıktıda kayboluyor. Kayıpsız AST kriterimizi karşılamıyor | [Depo açıklaması](https://github.com/evert/structured-headers), Compatibility; [ayrıştırıcı kaynak incelemesi](https://github.com/evert/structured-headers/blob/main/src/parser.ts), 195–218 |

### Structured Fields kararı
Öneri: incelenen structured-headers sürümünü runtime bağımlılığı olarak almamak; kullanıcının belirlediği fallback uyarınca iç ayrıştırıcı/serileştirici geliştirmek.
Ret gerekçesi bakım eksikliği değil, kayıpsız kanonikleştirme ve ham tekrar gözlemlenebilirliği kriterleridir.
Depo bakım faaliyeti, TypeScript, iki modül biçimi ve sıfır bağımlılık beyanı olumlu. Date/Display String yolları kaynakta görüldü.
Paketin gerçek kurulum boyutu ve yayın tarball'ı ölçülmedi; boyut kriteri geçti diye raporlanmıyor. Diğer zorunlu kriterlerde elendiği için üretim bağımlılığı önerilmiyor.
Ham tekrarların üzerine yazılması tek başına RFC ihlali değildir; ham AST ve standart anlamsal model ayrı tutulmalıdır.
Kendi uygulamamız için RFC 9651 uyumluluk testleri, kayıpsız sayı türleri, kaynak limitleri ve deterministik fuzz/property testleri zorunludur.
Resmî [HTTP WG Structured Fields test takımı](https://github.com/httpwg/structured-field-tests) uygulama aşamasında commit ve lisansıyla sabitlenir.
RFC 9421'in imza meta verisi kabul kuralları ile RFC 9651 genel parser yetenekleri karıştırılmaz.
Başka bir parser'ın tüm kriterleri geçtiğine dair inceleme yapılmadı; piyasada uygun hiçbir parser olmadığı iddia edilmez.

### Cloudflare referans uygulamasından çıkan sonuç
[Cloudflare deposu](https://github.com/cloudflare/web-bot-auth) TypeScript ve Rust paketleri, Workers örnekleri, dizin araçları ve araştırma test ortamı listeliyor.
Depo Apache-2.0; agentsig MIT olacak. Kod kopyalama önerilmiyor; gerekirse üçüncü taraf lisans/atıfları ayrıca korunur.
Açık araştırma sunucusu yayımlanmış RFC test anahtarını kullanır. Yalnızca test fixture'ında kullanılmalı; üretim anahtar üretimiyle karıştırılmamalıdır.
Araştırma ortamı testi, Cloudflare doküman formatı testi ve kayıt/onay gerektiren üretim Verified Bots testi ayrı sonuçlardır.
İncelenen ana dal örnekleri Dictionary biçimini kullanıyor; Cloudflare üretim dokümanı eski tek dizgi biçimini istiyor. Depo davranışı üretim kabulü kanıtı değildir.
Paket belgeleri incelendi; kriptografik kaynakların ve testlerin tamamı denetlenmedi. Alternatifler hakkında performans veya güvenlik üstünlüğü iddiası yapılmıyor.

### Konumlandırma
agentsig ilk Node HTTP imza motoru veya ilk TypeScript Web Bot Auth paketi değildir.
Hedef fark: Node yerleşik kripto ile açık, sürümü sabit profiller; varsayılan atomik replay kontrolü; güvenli keşif; framework adaptörleri; CLI ve kaynaklı uyumluluk matrisi.
Bu farklar henüz uygulanmış yetenekler değil, proje hedefleridir. Resmî IETF/Cloudflare referans uygulaması veya onaylı kütüphane iddiası yapılmaz.

## 10. İlk uygulama teslimatı
1. Monorepo temelini, MIT lisansı, pnpm/changesets ve ESM/CJS tip/test araçlarını kur; yalnızca core'u işlevsel paket olarak geliştir.
2. Bu belgedeki mesaj/tür/hata sözleşmelerini netleştir; ham hedef, kayıpsız SF türleri ve RFC kural-kapsam matrisini ekle.
3. RFC kaynaklarından bağımsız beklenen çıktıları ve anahtar fixture'larını sabitle; dört golden takımını önce hazırla.
4. Sınırlı kaynak tüketimli Structured Fields parser/serializer geliştir; RFC 9651 testlerini ve fuzz/property testlerini ekle.
5. RFC 9421 başlık ayrıştırma ve kanonikleştirme motorunu geliştir; destek dışı özellikleri açıkça reddet.
6. Ed25519 imzalama ve kriptografik doğrulamayı ekle; B.2.6 imza baytlarını birebir üret/doğrula, mutasyonları reddet.
7. ESM/CJS tüketici testlerini, tip kontrolünü, Node 20/22/24 ve Windows/Linux test matrisini çalıştır; gerçek çalıştırma durumlarını raporla.
8. Kök README'de neden agentsig, neden stealth değil, rate limit farkı ve kaynaklı Protocol compatibility bölümlerini hazırla.
9. İlk core teslimatında dur; profil, ağ, nonce deposu, adaptör ve CLI uygulamalarına ayrıca onay olmadan geçme. Yayınlama yapma.

Node 20 uyumluluk hedefi korunur; destek ömrü ve güncel LTS önerisi README'de ayrı açıklanır. Araçların minimum Node sürümleri kurulumdan önce kontrol edilir.
Dizin güvenlik limitleri, cache politikası ve WG vektör envanteri sonraki profil/dizin kilometre taşına geçiş kapılarıdır; ilk motor teslimatına ağ davranışı eklenmez.

## 11. core-m1: öneri ↔ uygulanan API karşılaştırması

İnceleme temeli: motor commit'i **b3b0829**, SF commit'i **584144c** ve bağımsız audit commit'i **5fd54d3**.
Kullanıcı, **core-m1** etiketinin push edildiğini ve CI matrisinin yeşil olduğunu bildirmiştir.
Bu kayıt sonraki yerel değişikliklerin CI sonucunu veya bir güvenlik denetimini temsil etmez.

**Sonuç:** Dört işlemli motorun sorumluluk ayrımında sapma yok. İlk tip taslağına göre aşağıdaki API farkları vardır; “birebir sapma yok” iddiası yapılmaz.
Bu karşılaştırma uygulama davranışını değiştirmez ve bütün RFC kurallarının güvenlik denetimi değildir.

| Alan | İlk öneri | Uygulanan sözleşme ve gerekçe |
| --- | --- | --- |
| Dört işlem | Ayrıştırma, imza tabanı, imzalama, kriptografik doğrulama | **Sapma yok.** [Dışa aktarımlar](../packages/core/src/index.ts:1) aynı dört işlemi sunar; son iki işlem Promise döndürür. |
| Ağ/saat/nonce/yetki | Saf motorun dışında | **Sapma yok.** [Kriptografik doğrulama](../packages/core/src/crypto.ts:80) yalnızca verilen açık anahtarla imzayı kontrol eder; gövde digest'ini de doğrulamaz. |
| Başlık değerleri | Yalnızca metin | [`HeaderField`](../packages/core/src/types.ts:8) ASCII metin veya ham bayt kabul eder. Binary-wrapped alanlarda özgün oktetleri UTF-8/Latin-1 tahminiyle değiştirmemek için genişletildi. |
| HTTP sürümü | Ayrı alan yok | [`RequestParts`](../packages/core/src/types.ts:11) ve [`HttpMessage`](../packages/core/src/types.ts:22) açık HTTP sürümü bağlamı taşıyor. Eski satır katlamasını yalnızca HTTP/1.1 bağlamında çözmek için eklendi. |
| Ham hedef ve yanıt bağlamı | İsteğe bağlı ham hedef ve ilgili request | **Sapma yok.** Ham hedef bileşeni kullanılıyorsa ayrıca sağlanır; ilişkili request yoksa tahmin edilmez. |
| Kaynak limitleri | Dört imza ayrıştırma limiti | [`Limits`](../packages/core/src/types.ts:52) mesaj başlıkları, URI, imza tabanı ve SF bütçesiyle genişletildi. Kullanıcının sonraki 16 KiB açık core bütçesi kararı uygulandı. |
| Ayrıştırma çağrısı | İkinci argüman zorunlu tam limit nesnesi | [`parseSignatureHeaders()`](../packages/core/src/signature-input.ts:118) isteğe bağlı kısmi bütçe değişiklikleri alır. [`LimitOverrides`](../packages/core/src/types.ts:63) dondurulmuş açık core varsayılanlarını güvenle özelleştirir; SF varsayılanına sessiz bağımlılık yoktur. |
| Kanonikleştirme seçenekleri | Yalnızca SF alan türleri | [`CanonicalizationOptions`](../packages/core/src/types.ts:68) çağrı başına limitleri de taşır; imza tabanı ve kodlama genişlemesini sınırlamak için eklendi. |
| SF tiplerinin sahibi | Core taslağında yerel SF türleri | Ayrı paket kararıyla [`BareItem` ve diğer SF türleri](../packages/structured-fields/src/index.ts:16) @agentsig/structured-fields tarafından sağlanır. Core [`Parameters`](../packages/core/src/types.ts:103) türünü tekrar dışa aktarır; eski SfBare/SfParameter adları core dış API'sinde yoktur. |
| Ret nedenleri | Beş neden | [`RejectionReason`](../packages/core/src/types.ts:86) algoritma uyuşmazlığı ve kaynak limiti nedenleriyle genişletildi. Bunlar yanlış imzadan ayrı tanı konmasını sağlar. |
| Hata sözleşmesi | Tipli parser/base hatası, beklenen crypto ret sonucu | [`Hata sınıfları`](../packages/core/src/errors.ts:1) bunu uygular; geçersiz çağıran yapılandırması sıradan imza reddine çevrilmez. Kripto sonucunda limit ayrıntıları değil yalnızca kaynak-ret kodu döner; ayrıntılar doğrudan işlem hatasında bulunur. |
| Çoklu imza | Etiket başına imza dizisi | [`Ayrıştırıcı`](../packages/core/src/signature-input.ts:113) tüm çiftleri işler: boş imzasız alanlar boş dizi verir, karşılığı eksik herhangi bir etiket bütün çağrıyı reddeder. Öneride belirtilmeyen bu daha katı all-pairs davranışı belgelenmiştir; tek etiket seçimi API'si yoktur. |
| Etiket/parametre tekrarları | Ham oluşumlar korunur, RFC semantiği ayrı uygulanır | SF ham AST korunur; RFC 9421 imza etiketleri tekrarlanamaz. Core'un anlamsal sonucu ham AST'yi döndürmez. Sonradan oluşturulmuş anlamsal parametre tekrarları serileştiricide reddedilir. |
| SF alan tür bilgisi | Çağıran tür tablosu | İmza alanları ve Content-Digest için yerleşik Dictionary bilgisi eklendi; diğer alanlar çağırandan gelir. Otomatik ağ/IANA sorgusu yoktur. |
| Kripto çalışma şekli | Promise tabanlı API | Dönüş tipi aynı; [uygulama](../packages/core/src/crypto.ts:35) sınırlı girdi üzerinde senkrondur. Promise, worker-thread veya bloklamayan kriptografi vaadi değildir. |
| Trailer ve algoritmalar | Trailer yok; yalnızca Ed25519 | **Sapma yok.** Açık ret davranışları ve dört bağımsız golden takımı vardır. |
| Tam Web Bot Auth sonucu | Sonraki katmanın taslağı | §4'teki profil, zaman, ReplayStore ve VerificationResult henüz dışa aktarılmıyor. Bu bir M1 eksikliği değil, onaylanan kapsam sınırıdır; M2'de kapalı kodlara daraltılacak. |

Güncel kullanım referansı: [core belgesi](../packages/core/README.md).
GitHub metadata adresi https://github.com/agentsig-dev/agentsig; npm kapsamı @agentsig olarak kalır.
Üç proje manifesti güncellenir; HTTP WG fixture içindeki üçüncü taraf manifest değiştirilmeyerek kaynak özeti ve provenance korunur.
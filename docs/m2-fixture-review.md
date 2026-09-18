# M2 fixture teslimatı ve uygulama onay kapısı

Tarih: 2026-09-18. Durum: **yalnızca kaynaklar, test verileri ve bağımsız audit**.
Profil doğrulayıcısı, zaman politikası veya replay deposu uygulanmadı.
Push ve yayınlama bu teslimatın parçası değildir.
Kullanıcı b6e2269 için Node 20/22/24 × Windows/Linux CI ve fixture integrity
workflow'unun yeşil olduğunu bildirdi. Aşağıdaki katalog revizyonu henüz
dondurulmadı; bu yeni değişikliklerin uzak CI sonucu ayrıca değerlendirilmelidir.
WG'ye gönderilmek üzere [nötr rapor taslağı](wg-e2-1-report-draft.md) hazırlandı;
hiçbir bildirim gönderilmedi.

## Kaynak sabitlemesi ve atıflar

| Kaynak | Sabitleme | Lisans |
| --- | --- | --- |
| Thibault Meunier / Sandor Major, HTTP Message Signatures for automated traffic | draft-ietf-webbotauth-httpsig-protocol-00, 2026-09-01; SHA-256: 3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0 | Tam belge kendi IETF Trust hükümlerine; çıkarılmış kod bileşenleri Revised BSD bildirimine tabidir |
| Cloudflare ve katkıcıları, Web Bot Auth | Commit acfb1f2270b9473ae65a15674995e0b2f3b6ab0c, 2026-07-01; SHA-256: c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7 | CC BY 4.0 |
| agentsig tarafından bağımsız hazırlanan kriptografik ve politika verileri | Yerel fixture commit'i; dosya başına SHA-256 ve bayt uzunluğu | MIT; bütün özel anahtarlar kamuya açık test verisidir |

Özgün kaynaklar:
- [IETF WG-00](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.txt)
- [Cloudflare sabit kaynak](https://github.com/cloudflare/cloudflare-docs/blob/acfb1f2270b9473ae65a15674995e0b2f3b6ab0c/src/content/docs/bots/reference/bot-verification/web-bot-auth.mdx)
- [Cloudflare CC BY 4.0 lisansı](../tests/fixtures/m2/sources/cloudflare-LICENSE.txt)
- [IETF atıf ve Revised BSD bildirimi](../tests/fixtures/m2/sources/IETF-NOTICE.txt)
- [Dosya manifesti](../tests/fixtures/m2/manifest.json)

Cloudflare materyali yeniden lisanslanmamıştır. Belge gövdesi değiştirilmeden
saklanır; §4.4 kod bloğu ayrıca çıkarılmıştır. Gösterim fixture'ı blok içeriğini
korur; ayrı başlık fixture'ında yalnızca girintili metadata devam satırları
birleştirilmiştir. Bu dönüşümler manifestte kayıtlıdır. Cloudflare/IETF onayı
veya ilişkisi iddia edilmez. Lisansların garanti reddi hükümleri korunur.

## Vektör envanteri

**WG-00 içinde gerçek vektör var.** Ek E.2.1, E.2.2 ve E.2.3'ün yayımlanmış
64 baytlık Ed25519 imzaları RFC 9421 B.1.4 açık anahtarıyla, agentsig motorunu
kullanmadan doğrulanmıştır.

| Veri | Bağımsız kripto sonucu | M2 açısından değerlendirme |
| --- | --- | --- |
| WG E.2.1 | Geçerli; taban 375 bayt | sig2 etiketi / agent2 üyesi uyuşmuyor. Ayrıca yöntem/hedef kapsamı eksik ve ömür M2 limitini aşıyor. Kaynak düzeltilmedi; pozitif M2 kabul vektörü değildir. |
| WG E.2.2 | Geçerli; taban 349 bayt | Eski string biçimi. Yöntem/hedef kapsamı eksik, ömür uzun. WG imzalayanın yeni biçimi veya varsayılan M2 kabulü olarak gösterilmez. |
| WG E.2.3 | Geçerli; taban 298 bayt; yayımlanmış gövde digest'i eşleşiyor | Dizin yanıtı; yalnızca arşiv/kripto envanteri. M2'ye content-digest veya dizin doğrulaması eklenmedi. |
| Cloudflare §4.4 | Gösterim aynen saklandı; birleştirilmiş imza başlıkları WG E.2.2 ile eşleşiyor | Belge-serileştirme fixture'ı, M2 pozitif kabul fixture'ı değil. Yetkili hedef/anahtar bağlamı sağlanmadan tek başına tam HTTP isteği sayılmaz. |
| Cloudflare §2 | Kaynak snapshot'ında mevcut; doküman açıkça temsili imza diyor | Kriptografik golden olarak kullanılmaz. Bu uyarı §4.4'e yanlışlıkla genellenmez. |
| WG E.1 RSA örnekleri | Envantere alındı; kriptografik olarak çalıştırılmadı | Ed25519 kapsamının dışında |
| İki agentsig profil fixture'ı | Ayrı gerçek test anahtarıyla imzalandı; bağımsız doğrulama ve deterministik yeniden imzalama eşleşti | Yöntem + hedef URI + doğru ajan bileşeni, 60 saniye ömür. Beklenen M2 kabulü henüz uygulama testi değildir. |

[Envanter](../tests/fixtures/m2/vector-inventory.json) ile
[politika verileri](../tests/fixtures/m2/policy-cases.json) ayrı tutulur.
Yeni test anahtarı deterministik, yayımlanmış test materyalidir; üretimde
kullanılamaz. İki profil fixture'ı aynı nonce'u kullanır ve her birinin pozitif
beklentisi **ayrı temiz depo** varsayar. Aynı depoda sırayla değerlendirilirlerse
ikinci kullanımın kabulü beklenmez; profil adı replay anahtarını ayırmamalıdır.

## Doğrulanan ve henüz doğrulanmayan işler

[Bağımsız M2 audit'i](../tests/m2-fixture-audit.test.mjs) yalnızca Node
standart modüllerini kullanır. Ağ, agentsig motoru ve aktarım betiği yardımcılarını
kullanmaz. Kaynak/fixture eşitliğini, manifest kapsamını, thumbprint girdisini,
anahtar/başlık/imza tutarlılığını ve üç Git satır sonu ayarını sınar.

Önceki fixture teslimatında yerel Windows / Node 22 üzerinde **12/12 audit testi geçti**.
Bu revizyonda E.2.1 için ayrıca etiket bağlama aşamasına özgü negatif kontrol eklendi;
yeniden çalıştırma sonucu teslimatta ayrıca raporlanır.
Politika verisindeki kod başvuruları ve TTL aritmetiği tutarlıdır; bunlar çalışan
bir doğrulayıcı, eşzamanlı replay deposu veya kota uygulaması testi değildir.
Aşağıdaki olay verileri onay sonrası uygulama testlerine dönüştürülecektir:
- 100 eşzamanlı aynı istekte bir kabul, 99 replay.
- Geçersiz kripto veya başarısız kimlik bağlamasında sıfır tüketim.
- Toplam dolulukta unavailable; anahtar kotasında ayrı kod; yaşayan kayıt atma yok.
- Optional noncesiz başarıda açık korumasız sonuç.
- Etiket adına bakmadan Web Bot Auth tag'iyle aday seçimi.
- Çoklu adayların hepsini raporlama; varsayılan üst düzey belirsizlik reddi.
- Gelecekteki created, tam süre sınırları ve korumacı saklama.

## Tam kapalı kod kataloğu

Aşağıdaki kümeler [makine-okunur katalogla](../tests/fixtures/m2/policy-cases.json)
aynıdır. Liste **uygulama öncesi onaya sunulan sözleşmedir**.
Başarı/ret kodu serbest metin değildir; teşhis ayrıntıları ayrı, sınırlı alanlarda
taşınabilir. Aday etiketi yalnızca sonuç korelasyonu içindir.

### unsigned — 2 kod

- no-signature
- no-web-bot-auth-candidate

İkinci neden yalnızca başlıklar başarıyla ayrıştırıldıktan sonra eşleşen tag
bulunmamasıdır. Bozuk/kısmi imza başlıkları imzasız trafik gibi kabul edilmez.

### verified — 2 kod

- nonce-consumed — replay korumalı başarı.
- nonce-absent-optional — yalnızca açık optional politikayla; replay koruması yok.

### invalid — 20 kod

- malformed-signature
- malformed-agent
- ambiguous-signatures
- ambiguous-profile
- agent-label-mismatch
- agent-binding-mismatch
- missing-required-parameter
- invalid-parameter
- invalid-time-range
- created-in-future
- signature-expired
- signature-too-old
- lifetime-exceeded
- insufficient-coverage
- key-id-mismatch
- algorithm-mismatch
- signature-mismatch
- nonce-required
- nonce-invalid
- replay-detected

### unverified — 11 kod

- unsupported-profile
- unsupported-algorithm
- unsupported-discovery-type
- profile-disallowed
- unknown-key
- agent-binding-missing
- resource-limit
- replay-store-unavailable
- per-key-quota-exceeded
- clock-unavailable
- test-key-disallowed

Buradaki unverified, doğrulamanın tamamlanamadığını belirtir; bütün alt kodların
altyapı arızası olduğu anlamına gelmez. Anahtar kotası bu yüzden kendi kodunu
taşır. Toplam doluluk ve depo arızası aynı unavailable depo sonucuna karşılık
gelir; ayrı full/capacity kodu yoktur. Başarısız sonuç doğrulanmış kimlik taşımaz.

### Kodların ayrımı

- **agent-binding-missing:** URL bağlaması gereken modda gerekli yerel eşleme yok.
  Düz JWKS/thumbprint modunda eşleme zorunlu değildir.
- **agent-binding-mismatch:** seçilmiş anahtar için eşleme var, ancak imzalı ajan
  URL'i kayıtlı URL ile uyuşmuyor. Sonuç invalid; nonce tüketilmez.
- **algorithm-mismatch:** bilinen HTTP imza algoritması, seçilmiş güvenilir anahtarın
  türü/algoritma kısıtıyla çelişiyor. Örneğin seçilmiş Ed25519 anahtarı ve
  RSA-PSS beyanı invalid olur; kriptografik deneme yapılmaz.
- **unsupported-algorithm:** algoritma uygulanmıyor/tanınmıyor ve seçilmiş anahtarla
  belirlenmiş bir çelişki yok. Sonuç unverified. Bilinen çelişki varsa önce
  algorithm-mismatch; bilinmeyen algoritmanın anahtar uyumu tahmin edilmez.
  Statik JWKS yapılandırmasının geçersiz olması ise ayrı yapılandırma hatasıdır.
- **aggregate-policy-required kaldırıldı.** Açık çoklu değerlendirme modunda toplu
  kural verilmemesi onaylanan varsayılan all'a gider. Geçersiz mod/kural veya
  çelişkili ayar invalid-candidate-policy yapılandırma hatasıdır.

### Oluşturma/yapılandırma hataları — 8 kod

- invalid-jwks
- invalid-key-configuration
- invalid-agent-binding
- invalid-time-policy
- invalid-replay-policy
- invalid-resource-limits
- invalid-clock-configuration
- invalid-candidate-policy

Bunlar istek sonucu değildir; oluşturma aşamasındaki tipli hatalardır.
Beklenmeyen programlama hataları sıradan invalid sonucuna dönüştürülmez.

### Atomik depo sonuçları — 4 kod

- accepted
- replayed
- unavailable
- per-key-quota-exceeded

Toplamda 35 doğrulama neden kodu, 8 yapılandırma kodu ve 4 depo sonucu vardır;
aynı yazım birden fazla farklı sözleşmede kullanılabilir.
Başarıda kimlik türü key-thumbprint veya açık eşleme varsa directory-url;
ikincisinin güven kaynağı yerel yapılandırmadır, TLS/dizin kanıtı değildir.

## Onaylanan altı karar

1. Varsayılan çoklu-aday reddinde bütün adaylar kripto/kimlik/zaman bakımından
   değerlendirilir; nonce tüketilmez, üst sonuç invalid / ambiguous-signatures.
2. Açık çoklu-aday modunda all varsayılan; any açık seçimdir. İkisinde de erken başarı yok.
3. Aynı doğrulama çağrısında uygun adayların aynı scope/anahtar/nonce üçlüsü
   tek atomik tüketimi paylaşır; ayrı istekler kabul sonucunu paylaşmaz.
4. Anahtar kotası tüm depo örneğinde thumbprint başınadır; scope'lara bölünmez.
5. Ret sırası: süresi dolanları temizle → replay → anahtar kotası → toplam kapasite.
6. Tüketim öncesi [`CandidateEvaluation`](../tests/fixtures/m2/policy-cases.json:1)
   iç tiptir; dış [`VerificationResult`](milestone-2-plan.md:153) yalnızca
   unsigned / verified / invalid / unverified durumlarını korur. Ara başarı
   dışarıya verified olarak sızdırılmaz.

Etiket başına dış sonuç dizisi korunur. Varsayılan belirsizlik reddinde,
ön kontrolleri geçen adaylara da tüketim yapılmadığından verified denmez;
dışa eşleme invalid / ambiguous-signatures olur. Ön kontrolleri geçemeyen
adayların gerçek ret nedenleri korunur. İç değerlendirme nesnesi dışa aktarılmaz.
Bu dışa eşleme önerisi nihai sözleşme onayına dahildir.

## Üretim kodundan önce kalan dört seçim

Aşağıdaki değerler **öneri, henüz onaylanmadı**. Onaylanan süre ve kapasite
varsayılanlarını değiştirmez; kod katalogda veya runtime'da dondurulmadı.

| Konu | Önerilen A seçeneği | Artı / eksi | B alternatifi ve etkisi |
| --- | --- | --- | --- |
| Saat anomalileri | İlk güvenilir duvar saati + monoton geçen süre; duvar saatiyle farkın mutlak değeri 30 sn'yi aşarsa veya monoton saat geriler/geçersizse clock-unavailable. Eşik yapılandırılabilir ve imza skew'undan ayrı ayardır. | Doğrulama zamanı geri yürümez, ileri duvar saati sıçraması kayıtları topluca erken sildirmez. Monoton saat ve saat senkronizasyonu gerektirir; uzun çalışmada drift nedeniyle ret olabilir. | Duvar saati + önceki zaman üst sınırı; herhangi bir geri adımda fail-closed. Daha basit, küçük NTP düzeltmelerinde daha çok ret; ileri sıçrama için yine monoton karşılaştırma veya operatör kontrolü gerekir. |
| Keşif türleri | M2'de yalnızca WG directory (tür yoksa varsayılan) ve Cloudflare'in eski string biçimi; diğer keşif türleri unsupported-discovery-type. | Küçük ve denetlenebilir çevrimdışı kapsam. JWKS-URI/CIMD kullanan meşru adayları kabul etmez. | jwks_uri/cimd değerlerini yalnızca açık yerel eşlemelerle destekle; ağ yine yok. Daha geniş uyum, ek URL normalizasyonu/kimlik semantiği ve fixture yükü. |
| Test anahtarları | RFC B.1.4 ve depoda yayımlanan M2 anahtarının thumbprint'lerini varsayılan reddet; yalnızca açık test izniyle kabul et. | Yaygın örnek anahtarların yanlışlıkla üretim kullanımını engeller; bütün bilinen/sızmış anahtarları tespit ettiği iddia edilemez. Negatif/pozitif testler ayrı test ayarı gerektirir. | Kontrolü tümüyle uygulamaya bırak; daha az özel durum, örnek anahtarın üretime taşınma riski yüksek. |
| İkincil limitler | JWKS metni 256 KiB / 64 anahtar; 16 Web Bot Auth adayı; nonce 1–256 printable ASCII bayt; üretilen nonce 32 rastgele bayt → padding'siz base64url. Yerel scope 1–256 ASCII bayt; 64 URL eşlemesi, URL başına 2048 ASCII bayt. | Statik yapılandırma ve saldırgan girdisinde kaynak tüketimi sınırlı; bazı uzun ama geçerli girdiler reddedilir. Gelen nonce'un entropisini kanıtlamaz. | 1 MiB / 256 anahtar / 64 aday / 1024 bayt nonce ve scope / 256 eşleme / 8192 bayt URL: daha fazla uyum, daha fazla bellek ve kripto işi. |

Saat seçeneği A'da önerilen toparlanma: bozuk örnekte nonce tüketme ve kayıt
temizleme yok; doğrulama saati eski referanstan ilerlemeye devam eder. Duvar
saati aynı referansla tekrar eşik içine girince, geçerli monoton örnekle devam
edilir. Otomatik rebase/reset ve depo boşaltma yoktur. Aynı depoyu paylaşan
doğrulayıcılar ortak saat alanı kullanmalıdır; süreç yeniden başlatılınca bellek
içi replay garantisi kaybolur. Monoton saat gerilemesi referansı bozarsa operatör
müdahalesi gerekir; sessiz kurtarma yapılmaz.

Limit seçeneği A'da ham JWKS metni boyut sınırı JSON ayrıştırmadan önce uygulanır.
Önceden ayrıştırılmış nesne kabul edilirse alan/anahtar/sayı sınırlarıyla doğrulanır;
nesneyi önce sınırsız serileştirip sonra boyut ölçmek kullanılmaz.
Kriptografik core'un 16 KiB bütçesi korunur; daha büyük profil aday limitleri
bu alt bütçeyi kendiliğinden genişletmez.
Eşlemenin varlığı ama URL uyuşmazlığı invalid; zorunlu eşlemenin yokluğu unverified.
İkincil limitler protokol MUST sınırları değil, yerel yapılandırılabilir bütçelerdir.

Bu seçenekler ve düzeltilmiş katalog onaylandıktan sonra önce yeni sınır/negatif
fixture'ları, ardından profil → zaman → replay → doğrulayıcı kodu gelir.
Her ana adımda tamamlanan işler, geçen/geçmeyen testler ve açık kararlar raporlanır.

## Çalıştırma ve kapsam sınırı

Audit: node --test tests/m2-fixture-audit.test.mjs

[Aktarım betiği](../scripts/import-m2-fixtures.mjs) önceden indirilen, özetleri
kontrol edilen kaynaklardan veri üretir. Üretilmiş dosyalar yeniden aktarımda
deterministik olmalıdır. Audit aktarım işlevlerini kullanmadan kontrol eder.
M1 kaynak/fixture manifesti ve kullanıcı tarafından eklenen bağımsız audit betiği
değiştirilmez. Bu çalışma üretim M2 API'sini başlatma onayı değildir.
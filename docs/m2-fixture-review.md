# M2 fixture teslimatı ve uygulama onay kapısı

Tarih: 2026-09-18. Durum: **yalnızca kaynaklar, test verileri ve bağımsız audit**.
Profil doğrulayıcısı, zaman politikası veya replay deposu uygulanmadı.
Push ve yayınlama bu teslimatın parçası değildir.

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

Yerel Windows / Node 22 çalıştırmasında **12/12 audit testi geçti**.
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

### unsigned — 1 kod

- no-signature

### verified — 2 kod

- nonce-consumed — replay korumalı başarı.
- nonce-absent-optional — yalnızca açık optional politikayla; replay koruması yok.

### invalid — 19 kod

- malformed-signature
- malformed-agent
- ambiguous-signatures
- ambiguous-profile
- agent-label-mismatch
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

### unverified — 12 kod

- no-web-bot-auth-candidate
- unsupported-profile
- unsupported-discovery-type
- profile-disallowed
- unknown-key
- agent-binding-missing
- resource-limit
- replay-store-unavailable
- per-key-quota-exceeded
- clock-unavailable
- test-key-disallowed
- aggregate-policy-required

Buradaki unverified, doğrulamanın tamamlanamadığını belirtir; bütün alt kodların
altyapı arızası olduğu anlamına gelmez. Anahtar kotası bu yüzden kendi kodunu
taşır. Toplam doluluk ve depo arızası aynı unavailable depo sonucuna karşılık
gelir; ayrı full/capacity kodu yoktur. Başarısız sonuç doğrulanmış kimlik taşımaz.

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

Toplamda 34 doğrulama neden kodu, 8 yapılandırma kodu ve 4 depo sonucu vardır;
aynı yazım birden fazla farklı sözleşmede kullanılabilir.
Başarıda kimlik türü key-thumbprint veya açık eşleme varsa directory-url;
ikincisinin güven kaynağı yerel yapılandırmadır, TLS/dizin kanıtı değildir.

## Üretim kodundan önce kalan kararlar

Onaylanan 60/300/300/30, 10.000 toplam kapasite, 1.000 anahtar kotası,
tag tabanlı aday seçimi ve güçlü istek kapsamı yeniden tartışmaya açılmıyor.
Aşağıdaki ayrıntılar bu kararların uygulanışını kesinleştirmek içindir:

| Konu | Öneri | Alternatif / etkisi |
| --- | --- | --- |
| Varsayılan çoklu-aday reddi | Her aday için kripto/kimlik/zaman teşhisi; nonce tüketme yok; üst düzey ambiguous-signatures | Her geçerli adayı tüketmek, reddedilen istekle nonce yakar. Önce hepsini değerlendirme kararı her iki seçenekte korunur. |
| Tüketim öncesi aday sonucu | Ayrı bir aşama bilgisi; hiçbir adaya replay kontrolü yapılmış verified denmez | Mevcut sonuç birliğine “not evaluated”/“pre-replay” durumları eklemek; katalog son onayda genişler |
| Açık çoklu-aday politikası | Tüm sonuçlar, açık all kabul kuralı; tüketimde erken başarı yok | Açık any politikası da sunulabilir, ancak yine bütün adaylar değerlendirilir. Çok anahtarlı atomik batch bu M2 deposunun mevcut taslağında yoktur. |
| Aynı nonce'lu adaylar | Tek istek içindeki aynı scope/anahtar/nonce için paylaşılmış tüketim sonucu; bağımsız isteklerde tekrar reddi | Sıralı ayrı tüketim ikinci adayı replay yapar; belge ve test sonucu farklı olur |
| Anahtar kotası | Depo örneği genelinde thumbprint başına; scope/profil/label ile kota kaçışı yok | Scope başına anahtar kotası daha iyi kiracı ayrımı, fakat aynı anahtar toplam kotayı bölebilir |
| Ret önceliği | Süresi dolanları temizle → mevcut replay → anahtar kotası → toplam kapasite | Başka sıra hem dolu hem kota aşılmış durumda farklı kod döndürür |
| Saat anomalileri | Monoton temelli, geri yürümeyen doğrulama zamanı; eşik ve fail-closed davranışı ayrıca seçilmeli | Her geri adımda doğrulamayı durdurmak daha basit fakat saat düzeltmelerinde erişilebilirliği azaltır |

Kaynak keşif türleri, bilinen test anahtarları ve ikincil kaynak limitleri
önceki planda hâlâ öneridir. Bu fixture teslimatı bunları sessizce onaylamaz.
Politika dosyasında açık bekleyen kararlar yer alır; uygulama kodu ve bu
yan etkileri sınayan gerçek testler ancak kullanıcı onayından sonra yazılır.

## Çalıştırma ve kapsam sınırı

Audit: node --test tests/m2-fixture-audit.test.mjs

[Aktarım betiği](../scripts/import-m2-fixtures.mjs) önceden indirilen, özetleri
kontrol edilen kaynaklardan veri üretir. Üretilmiş dosyalar yeniden aktarımda
deterministik olmalıdır. Audit aktarım işlevlerini kullanmadan kontrol eder.
M1 kaynak/fixture manifesti ve kullanıcı tarafından eklenen bağımsız audit betiği
değiştirilmez. Bu çalışma üretim M2 API'sini başlatma onayı değildir.
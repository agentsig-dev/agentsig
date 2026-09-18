# M2 ortak güvenlik bağlamı: saat, dönem ve sıfırlama

Durum: 2026-09-18. İç koordinatör ve yardımcıları uygulanmıştır.
Gerçek bellek içi replay deposu, dış bağlam fabrikası ve tam çevrimdışı
doğrulayıcı henüz tamamlanmamıştır. Depo entegrasyon testleri test dublörleri
kullanır; bu sonuçlar üretime hazırlık veya güvenlik denetimi iddiası değildir.

## Zaman ve saat sağlığı

[Saf zaman politikası](../packages/core/src/profiles/time-policy.ts) çağıranın
sağladığı tam sayı Unix saniyesini kullanır; kendi başına saat okumaz.
Oluşturma zamanı gelecekte en fazla yapılandırılmış tolerans kadar olabilir.
Sona erme oluşturma zamanından büyük olmalı ve azami ömrü aşmamalıdır.
Sona erme artı tolerans ve oluşturma artı azami yaş artı tolerans sınırları
hariçtir: tam sınırda ret verilir. Karşılaştırmalar taşmasız tam sayı
aritmetiğiyle yapılır. Zaman kontrolünü geçmek kimlik doğrulama değildir.

[Saat izleyicisi](../packages/core/src/profiles/clock-tracker.ts) etkin zamanı
başlangıç duvar saati ile monoton geçen sürenin toplamından hesaplar.
İmza zamanı bunun saniyeye aşağı yuvarlanmış değeridir.
Duvar saati ile etkin zaman arasındaki mutlak fark varsayılan 30 saniyeyi
aşarsa saat sağlıksızdır; eşik imza toleransından bağımsız yapılandırılır.

Duvar saati sapması aynı referansa göre tekrar sınır içine dönerse toparlanma
mümkündür. Monoton gerileme izleyiciyi kalıcı olarak geçersiz kılar ve açık
sıfırlama gerektirir. Otomatik referans yenileme veya replay temizleme yoktur.
Sağlıksız saatte zaman değeri doğrulama için sunulmaz ve depo çağrısı başlatılmaz.

## Paylaşılan dönem ve işlem sınırı

[İç koordinatör](../packages/core/src/profiles/security-context-controller.ts)
saat, [işlem dönemleri](../packages/core/src/profiles/operation-epochs.ts)
ve depo erişimini tek bağlamda yönetir. Aynı güvenlik bağlamındaki
doğrulayıcılar bağımsız saat sıfırlayamaz.

Dönem kimliği monoton artan, süreç-yerel bir tam sayıdır. İşlemler başladıkları
döneme ait bağlam-sahipli tanıtıcı taşır. Depoya gönderimden önce ve depo
beklemesinden sonra dönem ve saat sağlığı tekrar kontrol edilir.
Sonuç üretme aşamasında da kontrol zorunludur. Tam doğrulayıcı ayrıca
imzanın zaman penceresini yeniden sınamalıdır.

Dönem kimliği uzak depoya gönderilmez. Başka bağlamın veya sonlanmış dönemin
tanıtıcısı, sayısal dönem kimliği aynı olsa bile kabul edilmez.

## Operatör sıfırlaması

[Operatör hata kataloğu](../packages/core/src/profiles/operator-errors.ts)
dört ayrı, dondurulmuş kod içerir. İmzalayan ve doğrulama kataloglarıyla
ortak hata tipi veya birlik kullanılmaz.

| Hata | Davranış |
| --- | --- |
| reset-unsupported-store | Depo beyanı yok veya güvenli yerel temizleme yeteneği yok; referanslar, dönem ve kayıtlar korunur. |
| reset-in-progress | Başka sıfırlama sürüyor veya senkron yeniden giriş var; ikinci işlem durumu değiştirmez. |
| reset-clock-unavailable | Hazırlık saat örnekleri geçersiz; referanslar ve kayıtlar korunur, sağlık hatası gizlenmez. |
| reset-failed | Dönem kapatma, temizlik veya etkinleştirme tamamlanamadı; bağlam kapalı fakat yeniden denenebilir kalır. |

Sıra: yetenek/meşgul kontrolü → bağlamı kapatma → yeni saat örneklerini
doğrulama → eski dönemi geri alınamaz biçimde geçersiz kılma ve gerekiyorsa
bellek temizleme → son sağlık kontrolü ve yeni dönemi etkinleştirme.

Temizlik beklerken saat bozulursa yeni dönem açılmaz. Son kontrol hazırlanan
referansı kullanır; yeniden bir referans seçerek bozulmayı gizlemez.
Başarısızlık meşgul durumunu temizler; sonraki açık sıfırlama baştan denenebilir.
Eski dönem hiçbir başarısızlık yolunda yeniden etkinleştirilmez.

**Sağlıklı saatte de sıfırlama uygulanır. Bellek deposunun temizlenmesi
yıkıcıdır: daha önce tüketilmiş, hâlâ geçerli bir imza tekrar kabul edilebilir.**
Süreç yeniden başlatma da bellek içi replay geçmişini korumaz.
Sıfırlama sürerken doğrulama beklemez; saat kullanılamıyor sonucu alır.

## Depo saat beyanı

[Replay sözleşmesi](../packages/core/src/profiles/replay-store.ts) üç durumu ayırır:

- Süreç saatine bağlı: bağlama ait bellek kayıtları ve kota sayaçları temizlenir.
  Haricî deponun yalnızca bu beyanı vermesi onu temizleme yetkisi sağlamaz.
- Bağımsız saat: yerel sıfırlama kayıtları veya kotaları temizlemez; yerel dönem yenilenir.
- Beyan yok: normal tüketim mümkündür, fakat sıfırlama durumu değiştirmeden reddedilir.

Bağımsız depo adaptörleri kendi saat alanlarını, atomikliği ve TTL yuvarlamasını
ayrıca sağlamalıdır. Redis veya dağıtık sıfırlama protokolü M2'de uygulanmaz.

Önceden gönderilmiş uzak tüketim sıfırlama sonrasında tamamlanabilir; dağıtık
iptal garantisi verilmez. Yerel bağlam eski dönemden yeni tüketim başlatmaz
ve o doğrulama çağrısından doğrulanmış başarı üretmez. Tamamlanan yazma,
eski saatle hesaplanmış süreyle gereksiz kayıt tutabilir. Bu, mevcut canlı
kaydı silmeyen veya süresini kısaltmayan atomik depo sözleşmesi altında
replay güvenliğini zayıflatmaz; erişilebilirliği azaltabilir.
Aynı nonce başka çağrıda kabul edilmiş olabileceğinden, nonce'un hiçbir
zaman kabul edilmediği genellemesi yapılmaz.

## Olaylar ve gözlemci

[Olay şeması](../packages/core/src/profiles/context-events.ts) sıfırlama nedeni,
eski/yeni dönem, temizlenen kayıt ve kota sayıları, geçersiz kılınan işlem
sayısı, depo beyanı ve sonucu taşır. Sağlık olayları yalnızca geçişlerde üretilir.
Kısmi temizlikte bilinen gerçek sayaçlar raporlanır; bilinmeyenler açıkça
bilinmeyen kalır. Anahtar, nonce, başlık veya ham altyapı hatası taşınmaz.

[Tek senkron gözlemci](../packages/core/src/profiles/context-observer.ts)
bağlam oluşturulurken verilir; değiştirme veya çıkarma yoktur.
İlgili durum kesinleştikten sonra, çağırana dönmeden önce olay başına bir kez
çağrılır. Başarısız sıfırlamalar da olay üretir.
Her tür senkron fırlatma yutulur; ham değer saklanmaz veya loglanmaz.
Salt okunur hata sayacı artar; ikincil hata hook'u yoktur.

Gözlemcinin senkron çağrı yığınından doğrulama yeniden girişi saat kullanılamıyor,
sıfırlama yeniden girişi meşgul sıfırlama reddi alır. Bu retler yeni olay üretmez.
Koruma hata halinde de temizlenir; ertelenmiş işe taşınmaz.
Tamamlanmış sıfırlamanın sonucu gözlemci hatası nedeniyle değişmez.

**Hook içinde ağır iş yapmayın; senkron hook çağıranı ve sıfırlamayı geciktirir.**
Örnek düzen: hook yalnızca temizlenmiş olay verisini uygulamanın sınırlı
log kuyruğuna bırakır; ayrı tüketici yazmayı yapar ve kendi asenkron hatalarını
yönetir. [Ertelenmiş çağrı testi](../packages/core/test/profile-context-observer.test.ts)
korumanın senkron dönüşten sonra sona erdiğini gösterir. Kuyruk taşma
politikası uygulamaya aittir. Hook'un döndürdüğü asenkron sonuç beklenmez;
ertelenmiş hata bu senkron yakalama sınırına dahil değildir.

## Doğrulama durumu

Dönem/sıfırlama fixture'ları b1c7bee, gözlemci fixture'ları f9466af yerel
commit'lerinde koordinatörden önce sabitlenmiştir.
[Bağımsız denetim](../tests/reset-fixture-audit.test.mjs) uygulama kodunu kullanmaz.
[Bağlam testleri](../packages/core/test/profile-security-context.test.ts)
bilinen kısmi temizlik, yeniden deneme, saat değişimi ve yeniden giriş
regresyonlarını test dublörleriyle sınar.

Windows / Node 22 üzerinde bu alt adıma ait 102 hedefli test geçti.
Tam yerel regresyonda 4.136 birim testi, mevcut entegrasyon takımı,
54 bağımsız fixture denetimi ve M1 audit'i başarılıdır. İki paketin
derleme ve tip kontrolleri de geçti. Mevcut ESM/CJS tüketici kontrolleri
M1 girişlerini kapsar; profil dışa aktarımlarını henüz sınamaz.
Gerçek bellek deposu, dış bağlam fabrikası, doğrulayıcı ve profil ESM/CJS
tüketici testleri bekliyor. Depo koordinasyonu test dublörleriyle sınandı;
uzak CI sonucu doğrulanmadı.
Push, yayın veya WG bildirimi yapılmadı.
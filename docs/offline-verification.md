# Çevrimdışı Web Bot Auth doğrulaması

Durum: 2026-09-18. İki sabit profilin imzalayan/doğrulayıcı entegrasyonu ve
ESM/CJS tüketici testleri yerelde başarılıdır. Ön sürümdür; bağımsız güvenlik
denetimi, üretime hazırlık veya canlı Cloudflare kabulü iddia edilmez.

## Paket girişi ve temel akış

Paket adı @agentsig/core; profil alt yolu @agentsig/core/profiles.
[Koşullu paket dışa aktarımları](../packages/core/package.json) ESM/CJS için
ayrı çalışma zamanı ve tip bildirimleri sağlar. Saf RFC 9421 girişi korunur.
[Dış profil API'si](../packages/core/src/profiles.ts) iç koordinatörü, işlem
tanıtıcılarını veya doğrulama öncesi kimlik önerilerini dışa açmaz.

1. Güvenilir yerel açık JWKS ve uygulamanın replay ad alanını hazırlayın.
2. [createSecurityContext()](../packages/core/src/profiles/security-context.ts:91)
   ile uzun ömürlü ortak bağlam oluşturun veya doğrulayıcının kendi varsayılan
   bellek bağlamını kullanın.
3. [createOfflineVerifier()](../packages/core/src/profiles/verifier.ts:89)
   ile doğrulayıcıyı bir kez oluşturun. İstek başına yeniden oluşturmayın.
4. [OfflineVerifier.verify()](../packages/core/src/profiles/verification-types.ts:106)
   çağrısına dışarıdan görülen yöntemi, tam mutlak hedef URI'yi ve sıralı başlık
   oluşumlarını verin. İmza başlıkları dahil özgün değerleri koruyun.
5. [VerificationResult](../packages/core/src/profiles/verification-types.ts:56)
   üst durumunu uygulamanın kabul politikasıyla değerlendirin; imza doğrulaması
   erişim izni, itibar veya hız sınırından muafiyet değildir.

İmzalayan taraf
[createWebBotAuthSigner()](../packages/core/src/profiles/signer.ts:39)
ile oluşturulur. Dönen üç başlığı aynı, değiştirilmemiş isteğe eklemek çağıranın
işidir. Mevcut imza başlıklarını birleştirmez. Ayrıntılar:
[imzalayan sözleşmesi](profile-signing.md).
[Çalıştırılan tüketici örnekleri](../tests/profile-consumer.test.mjs)
iki modül biçiminde bu akışı gerçek paket adıyla sınar.

## Yapılandırma ve kimlik

[OfflineVerifierOptions](../packages/core/src/profiles/verification-types.ts:82)
yerel JWKS, açık replay ad alanı, ortak bağlam, aday politikası, kabul edilen
profiller, profil başına zaman/nonce politikası ve yerel kimlik bağlarını alır.
Yapılandırma hataları kurulumda fırlatılır; uzak isteğin geçersizliği sayılmaz.

Anahtarlar yalnızca güvenilir yerel yapılandırmadan yüklenir. İstekten anahtar
materyali alınmaz. Bilinmeyen anahtar ağ keşfini tetiklemez.
[loadJwks()](../packages/core/src/profiles/jwks.ts:91) sınırlı açık anahtar
yüklemesi ve raporlama sağlar; yükleme başarısı kimlik doğrulama değildir.
Genel JWKS ile WG dizin biçimi açıkça ayrıdır:
[JWKS politikaları](jwks-loading.md).

Varsayılan başarı yalnızca doğrulanmış anahtar thumbprint'ini belirtir.
İmzalı ajan URL'si ayrıca bir iddiadır; alan adı veya operatör sahipliği kanıtı
değildir. Dizin URL kimliği yalnızca açık yerel bağlama modu ve eşleşen
thumbprint/origin ilişkisiyle üretilir. Güven kaynağı yerel yapılandırmadır;
DNS, TLS veya imzalı dizin yanıtı kanıtı değildir.

Anahtar rotasyonunda yeni doğrulayıcıya aynı güvenlik bağlamını ve aynı replay
ad alanını verin. Ayrı bağlamlar, süreçler ve worker'lar varsayılan bellek
geçmişini paylaşmaz. Bağlamı yeniden oluşturmak eski replay kayıtlarını taşımaz.
Bilinen kamuya açık test anahtarları varsayılan reddedilir; açık test izni
diğer kontrolleri kaldırmaz. Liste bütün tehlikeli anahtarları kapsamaz.

## Profiller ve sonuçlar

İmzalayanda WG-00 varsayılandır; Cloudflare doküman profili açıkça seçilir.
Doğrulayıcı varsayılan iki grameri tanır; kabul edilen profil listesi daraltılabilir.
Başlığın biçimi bir gramer seçer; hata halinde diğer profile yeniden deneme yoktur.

İki profilde de yöntem, tam hedef URI ve profile özgü ajan bileşeni zorunludur.
Origin karşılaştırması gelen imzalı baytları yeniden yazmaz.
[Profil kimliği ve kapsam politikaları](profile-identity-policy.md)
protokol gereksinimleriyle daha sıkı yerel tercihleri ayırır.

Adaylar etiket adına göre değil protokol tag'ine göre seçilir.
Ham tekrar ve bütün imza çiftlerinin ayrıştırılması seçimden önce yapılır.
Bozuk ilgisiz bir çift bütün isteği reddeder; bu yerel M1 tüm-çiftler sınırıdır.

Varsayılan tam bir aday ister. Birden fazla adayın tamamı değerlendirilir;
ret alan aday sayımdan düşmez. Üst sonuç belirsizlik reddidir, nonce tüketilmez
ve replay öncesi uygunluk başarılı aday olarak gösterilmez.
Açık çoklu aday modunda varsayılan bütün adayların başarısıdır; herhangi birinin
başarısını yeterli görmek ayrıca seçilir. İki modda da erken başarı yoktur.

Bütün aday sonuçları başlık sırasında korunur. Başarısız üst sonuç başarılı
bir alt aday içerebilir; alt başarı üst kabulün yerine geçmez. Birden fazla
başarıdan tek operatör kimliği seçilmez. Başarı özet nedeni, başarılı adaylardan
herhangi biri nonce'suzsa korumasız başarıyı belirtir; her adayın replay bilgisi
ayrıca incelenmelidir. Beklenmeyen programlama hataları genel retle gizlenmez.

## Replay, zaman ve sıfırlama

Nonce varsayılan zorunludur. İsteğe bağlı politika yalnızca yokluğu gevşetir;
mevcut nonce için replay veya depo hatası başarıya çevrilmez.
Aynı doğrulama çağrısında uygun adayların aynı ad alanı/anahtar/nonce üçlüsü
tek atomik tüketim sonucunu paylaşır. Farklı istekler bu kabulü paylaşmaz;
profil ve etiket değiştirmek replay ad alanını bölmez.

Saklama hesabı gönderim anının sağlıklı saat örneğini kullanır:
oluşturma ile tüketim zamanının büyüğü, artı azami yaş ve tolerans.
Ortak grubun uygun üyeleri için en uzun gereken süre kullanılır.
Gönderim öncesi, bekleme sonrası ve nihai sonuçta zaman yeniden kontrol edilir.
Süre dolumu veya sıfırlama sonrasında tüketilmiş nonce geri alınmaz.

Varsayılan bellek sınırı 10.000 kayıt ve bütün ad alanları boyunca anahtar
başına 1.000 kayıttır. Yaşayan kayıt atılmaz. Toplam doluluk depo kullanılamıyor,
anahtar kotası ayrı kota sonucu üretir. Bunlar uygulama rate limit'i değildir.

[Ortak saat/replay bağlamı](security-context.md) monoton referans, sağlık
kontrolü ve işlem dönemiyle eski bekleyen işlemlerin başarı üretmesini engeller.
**Açık saat sıfırlaması sağlıklı bağlamda da yıkıcıdır: bellek geçmişini siler,
hâlâ geçerli eski isteğin yeniden kabulünü mümkün kılar.**
Otomatik sıfırlama yoktur. Bağımsız saatli depoya önceden gönderilmiş işlem
iptal edilemeyebilir; eski yerel doğrulama yine de başarılı dönmez.

## Doğrulanan kapsam ve sınırlar

Yerel Windows / Node 22 çalıştırmasında 4.284 birim testi, 13 entegrasyon testi,
60 bağımsız ek fixture denetimi ve bağımsız M1 audit'i geçti.
[Round-trip kabul kapısı](../packages/core/test/profile-verifier-roundtrip.test.ts)
iki profilin dört golden çıktısında tam başarı ve tekrar reddini sınar.
Her profil için 100 eşzamanlı aynı istekte bir kabul ve 99 replay reddi gözlendi.
[Çoklu aday testleri](../packages/core/test/profile-verifier-multiple.test.ts)
ortak tüketim, belirsizlik, toplu politika ve sıfırlama yarışlarını kapsar.

Bu yeni değişiklikler için uzak Node 20/22/24 × Windows/Linux matrisi henüz
doğrulanmadı. Ağdan keşif, SSRF/DNS koruması, dizin cache'i, gövde digest
karşılaştırması, countersignature, framework adaptörleri ve CLI kapsam dışıdır.
Canlı Cloudflare testi, push, yayın veya WG bildirimi asistan tarafından yapılmadı.
Dondurulmuş sonuç, imzalayan ve operatör kataloglarının değişimi ayrı onay ve
sürüm notu gerektirir; fixture denetimi tek başına tam protokol uyumluluğu değildir.
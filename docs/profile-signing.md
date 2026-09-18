# M2 profil imzalayanı

Durum: 2026-09-18. Kaynak uygulaması ve golden testleri mevcut; profil paket
girişi ve tam çevrimdışı doğrulayıcı entegrasyonu henüz tamamlanmadı.
Güvenlik incelemesinden geçmiş veya üretime hazır olduğu iddia edilmez.

## Sözleşme

[İmzalayan fabrikası](../packages/core/src/profiles/signer.ts) güvenilir yerel
yapılandırmadan bir imzalayan oluşturur. Her çağrı temiz bir istek tanımı alır;
kanonik adlarıyla Signature-Input, Signature ve Signature-Agent başlıklarını
sıralı, değişmez ad/değer çiftleri olarak döndürür. Başlıkları isteğe eklemek
çağıranın sorumluluğudur.

Varsayılan profil WG-00, varsayılan etiket sig1 ve imzalama ömrü 60 saniyedir.
Cloudflare doküman profili açıkça seçilir; otomatik downgrade veya yeniden
deneme yoktur. WG ajan Dictionary üyesinin anahtarı imza etiketiyle aynıdır.
Cloudflare ajan başlığı tek String olduğundan etiketi içermez.

Zorunlu kapsam yöntem, tam hedef URI ve profile özgü ajan bileşenidir.
Ek bileşenler bu kapsamı kaldıramaz. Gövde bütünlüğü kontrol edilmez;
Content-Digest alanını kapsamak gövdenin digest ile karşılaştırıldığı anlamına gelmez.

[Ortak origin doğrulaması](../packages/core/src/profiles/agent-origin.ts)
imzalayanda da kullanılır. Yeni oluşturulan ajan başlığı kanonik origin taşır.
Buna karşılık doğrulayıcı gelen imzalı başlığı yeniden yazmaz.

## Mevcut başlıklar ve mutasyon

Signature, Signature-Input veya Signature-Agent başlıklarından herhangi biri
mevcutsa imzalama reddedilir. İsim kontrolü harf büyüklüğünden bağımsızdır;
boş değer de başlığın mevcut olduğu anlamına gelir. Birleştirme veya sessiz
üzerine yazma yoktur. Bu yerel M2 imzalayan sınırı, doğrulayıcının bağımsız
çoklu aday desteğini kaldırmaz.

[İstek kopyası](../packages/core/src/profiles/signing-request.ts) sağlayıcılar
çağrılmadan oluşturulur. Özgün istek, başlık dizisi, başlık çiftleri ve bayt
dizileri değiştirilmez. Sağlayıcının kapalı değişkenler üzerinden özgün isteği
değiştirmesi kopyalanmış imza girdisini değiştiremez. Dönen başlıkların aynı
isteğe uygulanması ve gönderime kadar isteğin korunması çağıranın sorumluluğudur.

## Saat ve nonce sağlayıcıları

[Senkron sağlayıcı sözleşmesi](../packages/core/src/profiles/signing-providers.ts)
Unix milisaniyesi döndüren saat ve metin döndüren nonce üreteci kullanır.
Varsayılan saat platform duvar saatidir; varsayılan nonce 32 kriptografik
rastgele baytın padding içermeyen base64url kodlamasıdır.

Saat çıktısı sonlu, negatif olmayan sayı olmalıdır. Oluşturma zamanı
milisaniyenin 1000'e bölümünün aşağı yuvarlanmasıdır; sona erme zamanı buna
yapılandırılmış ömrün eklenmesidir. Her ikisi de SF Integer aralığında olmalıdır.
Bu duvar saati sağlayıcısı, sonraki doğrulayıcının monoton saat sağlık
mekanizmasının yerine geçmez.

[Ortak nonce yardımcısı](../packages/core/src/profiles/nonce.ts) varsayılan
1–256 printable ASCII kuralını uygular; boşluk, tırnak ve ters eğik çizgi
geçerlidir. Değer kırpılmaz veya normalize edilmez. İmzalayan nonce'u SF String
olarak serileştirir; sağlayıcı çıktısını ham başlık metnine birleştirmez.

**Sabit saat ve deterministik nonce sağlayıcıları test içindir. Üretimde
kullanımları eski zaman damgaları veya tekrar eden nonce değerleri üretebilir.**
Varsayılan üretici her çağrıda güvenli rastgele kaynağı kullanır; deterministik
bir geri dönüş yolu yoktur. Sağlayıcı çıktısının sözdizimi entropiyi kanıtlamaz.

Asenkron sağlayıcı çıktıları kabul edilmez veya beklenmez. Uzak anahtar
servisleri ileride ayrı imza sağlayıcısı arayüzü gerektirir. Dönüşün asenkron
arayüzü, mevcut kriptografinin worker üzerinde çalıştığı anlamına gelmez.

## Ayrı kapalı hata kataloğu

[İmzalayan hataları](../packages/core/src/profiles/signing-errors.ts) tek sınıf,
kararlı kod ve boş, değişmez ayrıntı alanı kullanır. Katalog 13 koddan oluşur:

- existing-signature-headers
- invalid-signing-key
- test-key-disallowed
- invalid-agent-origin
- invalid-label
- unsupported-profile
- unsupported-component
- invalid-request
- invalid-signing-options
- clock-unavailable
- nonce-generation-failed
- resource-limit
- signing-failed

Katalog sürümü 1'dir ve dondurulmuştur; değişiklik ayrı onay ve sürüm notu
gerektirir. Doğrulama kataloğuyla ortak tip/birlik değildir. Aynı yazımlı
kodlar aynı hata sınırını ifade etmez.

Sağlayıcıların ham hata mesajları, nonce ve anahtar materyali hata mesajı,
ayrıntıları veya neden zincirine alınmaz. Kripto hatası yalnızca kripto
çağrısının sınırında eşlenir; beklenmeyen uygulama hataları genel bir hata
koduyla gizlenmez. Bilinen kamuya açık test anahtarları varsayılan reddedilir;
açık test izni diğer güvenlik kontrollerini kaldırmaz.

## Golden ölçütü ve kalan entegrasyon

Fixture'lar uygulamadan önce bb54838 yerel commit'ine alınmıştır.
[Bağımsız fixture denetimi](../tests/signing-fixture-audit.test.mjs) agentsig
kodunu kullanmadan dört imzayı ve tam başlık baytlarını doğrular.
[Gerçek imzalayan testleri](../packages/core/test/profile-signer.test.ts)
iki profilde normal ve kaçış gerektiren nonce ile çıktının fixture'a bayt
eşitliğini sınar; golden kabul ölçütü kendi imzalayanımızla round-trip değildir.

Yerel Windows / Node 22 üzerinde imzalayan ve yardımcılarına ait 168 test geçti.
Bu alt adımın tam regresyonu da başarılıdır: 4.034 birim testi, 9 entegrasyon
testi, 44 bağımsız fixture denetimi ve M1 audit'i geçti. İki paketin derleme
ve tip kontrolleri başarılıdır. Mevcut ESM/CJS tüketici testleri M1 girişlerini
kapsar; profil girişlerinin tüketici testleri henüz eklenmedi.
Bu değişikliklerin uzak CI matrisi henüz doğrulanmadı.

**Tam çevrimdışı doğrulayıcıdan verified sonucu alan round-trip testi,
zaman ve replay katmanları tamamlandığında zorunlu entegrasyon kapısıdır.**
Mevcut saf kriptografik doğrulama bunun yerine sayılmaz.
Paket dışa aktarımları ve ESM/CJS profil tüketici testleri henüz beklemektedir.
Push, yayın ve WG bildirimi yapılmadı.
# M2 yerel JWKS yükleme sözleşmesi

Tarih: 2026-09-18. Durum: yükleyici kaynak kodu ve testleri mevcut;
tam Web Bot Auth profil doğrulayıcısı henüz tamamlanmadı.
Bu yardımcılar mevcut yayımlanabilir paket girişinden dışa aktarılmıyor.
Güvenlik incelemesinden geçmiş veya üretime hazır olduğu iddia edilmez.

## Güven sınırı

[Yerel yükleyici](../packages/core/src/profiles/jwks.ts) yalnızca uygulamanın
güvenilir yapılandırmasını kabul eder. İstekten gelen açık anahtarlar güvenilir
yapılandırma yerine kullanılamaz. Ağ erişimi, sertifika indirme, dizin keşfi,
otomatik yenileme ve alan adı sahipliği kanıtı yoktur.

Nesne, JSON metni veya UTF-8 bayt girdisi desteklenir. Varsayılan bütçe
256 KiB ve 64 anahtardır; desteklenmeyen ve tekrar eden girdiler de sayılır.
[Girdi kopyalama](../packages/core/src/profiles/jwks-input.ts), çağıranın sonraki
mutasyonlarını yüklenen görünümden ayırır. Boyut bütçesi JSON temsilini sınırlar;
JavaScript yığın belleğinin tam ölçümü değildir. Nesneler güvenilir yerel
yapılandırmadır; çalıştırılabilir Proxy nesneleri için bir sandbox sağlanmaz.

Anahtar seçimi yalnızca yeniden hesaplanan SHA-256 RFC 7638 thumbprint ile yapılır.
Yükleme veya anahtar bulma; imza doğrulama, nonce tüketimi, saat kontrolü,
test anahtarına izin verme ya da URL kimliği bağlama anlamına gelmez.

## İki açık girdi biçimi

| Biçim | Ed25519 algoritma metadata’sı | Anahtar etiketi |
| --- | --- | --- |
| Varsayılan genel JWKS | Yok veya tam JOSE EdDSA adı | İsteğe bağlı serbest metin; seçimde kullanılmaz |
| WG directory-00 | Yok veya tam HTTP ed25519 adı | Varsa hesaplanan thumbprint ile eşit olmalı |

Biçimler arasında sessiz isim çevirisi veya otomatik yeniden deneme yoktur.
WG etiket kuralının kaynağı §5.5; algoritma adları kuralının kaynağı §5.5.1’dir.
[Özgün bölüm alıntısı](../tests/fixtures/jwks/wg-discovery-format-excerpt.txt)
aynen korunur. Bu bölümler kullanım amacı veya anahtar işlemleri için ek normatif
kısıt getirmez; örnekte imza kullanım amacı bulunur.

## Kullanım politikası A

[Yerel kullanım politikası](../packages/core/src/profiles/jwks-usage.ts)
iki biçimde de aynıdır. Ed25519 için kullanım amacı yok veya imza olmalıdır.
İşlem listesi yoksa kabul edilir; varsa doğrulamayı içermeli ve yalnızca
imzalama/doğrulama işlemlerinden oluşmalıdır.

Bozuk metadata türleri, tekrarlanan işlemler ve bilinen kullanım/işlem
çelişkileri tüm yüklemeyi reddeder. Ed25519’e özgü kısıt bütün OKP ailesine
uygulanmaz: X25519 ve Ed448, yalnızca şifreleme kullanım amacı taşıdıkları
için reddedilmez. Geçerli desteklenmeyen anahtarlar raporlanarak atlanır.

## Desteklenmeyen anahtarlarda algoritma politikası B

[Algoritma sınıflandırması](../packages/core/src/profiles/jwks-algorithm.ts)
yeni kriptografik algoritma desteği sağlamaz.

1. Algoritma metadata’sı yoksa anahtar raporlanır ve atlanır.
2. Ad kendi biçiminin sabit listesinde ise raporlanır ve atlanır.
   Genel anahtar-algoritma uyumu denetlenmez.
3. Ad karşı biçimin listesinde ise tüm yükleme biçim hatasıyla reddedilir.
4. Ad iki listede de yoksa anahtar bilinmeyen algoritma adı nedeniyle atlanır.
   Bu ayrı yükleme raporu nedenidir; donmuş istek sonuç kataloğuna ek değildir.
5. Kendi biçiminin Ed25519 algoritma adını taşıyan başka tür/eğride anahtar
   reddedilir. Ed448 ile JOSE EdDSA eşleşmesi RFC 8037’de geçerlidir;
   buradaki ret açıkça onaylanmış daha dar yerel politikadır.
6. Simetrik anahtarlar, sır alanları eksik olsa bile açık JWKS’te reddedilir.

WG §5.5.1 kayıt üyeliği, kullanılabilir Ed25519 anahtarları için katı uygulanır.
Doğrulamaya alınmayan anahtarlarda bilinmeyen isimler, sabit kayıt listesinin
eskimesi nedeniyle tek başına tüm kümeyi düşürmez. Dolayısıyla başarılı yükleme,
atlanan girdiler dahil belgenin tam WG dizin uyumluluğunu kanıtlamaz.

Atlanan anahtar nesneleri doğrulama havuzuna verilmez. Böyle bir anahtarın
thumbprint’i sorgulanırsa desteklenmeyen algoritma sonucu alınır;
bilinmeyen thumbprint için bilinmeyen anahtar sonucu döner. Hiçbiri ağ çağrısı başlatmaz.

## Hatalar ve operatör teşhisi

[Yapılandırma hataları](../packages/core/src/profiles/jwks-error.ts),
donmuş geçersiz-JWKS kodunu koruyarak sıfır tabanlı anahtar indeksi, varsa etiket
ve ihlal açıklaması taşır. Ayrıştırma veya toplam bütçe hatası anahtar indeksi
belirlenmeden oluşabilir; bu durumda belge düzeyinde teşhis verilir.

Mesajdaki etiket kontrol karakterleri kaçışlanır; 256 UTF-16 kod birimini aşan
etiket açık kısaltma işaretiyle gösterilir. Ham etiket yapılandırılmış teşhis
alanında korunur: bu alan doğrudan terminale veya satır tabanlı günlüğe yazılmamalıdır.
Anahtar bileşenleri, özel materyal ve kripto altyapısı hata metni mesaja eklenmez.

## Kaynaklar, fixture’lar ve doğrulama durumu

[Ad listeleri](../tests/fixtures/jwks/algorithm-lists.json):
JOSE için RFC 7518 ve RFC 8037’de algoritma kullanım konumuna kayıtlı 31 ad;
içerik şifreleme kullanım konumuna ait kayıtlar dahil değildir.
HTTP için RFC 9421 §6.2’ye bağlı IANA kaydından 6 ad alınmıştır.

[IANA kaynağı](https://www.iana.org/assignments/http-message-signature/http-message-signature.xml)
2026-09-18T20:36:24.390Z anında alınmıştır; kayıt güncellemesi 2026-07-20’dir.
Özgün snapshot SHA-256:
bd4b0304e21e226fef189ed283a31392b5ffc99a37d00e9911dc011dcfb1523f.
Kaynak baytları, iki satır sonu boşluğu dahil korunmuştur.
RFC belgeleri özgün lisans bildirimlerini korur; proje MIT lisansı bu kaynakları
yeniden lisanslamaz. IANA kaydı IANA’ya atfedilir; herhangi bir onay ilişkisi yoktur.

Fixture’lar üretim yükleyicisinden önce ayrı yerel commit’lere alınmıştır:
ab8812f temel JWKS kaynakları; 1fd6fd5 kullanım politikası;
45153ff algoritma listeleri ve altı kural.

[Bağımsız denetim](../tests/jwks-fixture-audit.test.mjs) agentsig kodunu kullanmaz.
32 temel, 54 kullanım ve 410 algoritma senaryosu sabitlenmiştir.
[Yükleyici testleri](../packages/core/test/profile-jwks.test.ts) bu 496 senaryoyu
nesne, metin ve bayt girdileriyle çalıştırır; ayrıca sınır kontrolleri içerir.

Bu alt adımda yerel Windows / Node 22 üzerinde tam regresyon geçti:
3.661 birim testi (625 profil testi dahil), 9 entegrasyon testi, 27 bağımsız
JWKS/M2 denetimi ve M1 fixture audit'i başarılıdır. İki paketin derleme ve
tip kontrolleri de geçti. ESM/CJS tüketici testleri mevcut M1 girişlerini kapsar;
JWKS yardımcılarının paket dışa aktarımı ve tüketici testleri henüz eklenmedi.
Yeni değişikliklerin uzak Node 20/22/24 × Windows/Linux sonuçları henüz
doğrulanmadı. Push ve yayın yapılmadı.
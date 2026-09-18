# Fixture kaynakları ve yeniden üretilebilirlik

## Kapsam

Bu veri kümesi herhangi bir agentsig kütüphane uygulamasından önce hazırlanmıştır.
Beklenen imza ve kanonik metin agentsig tarafından üretilmemiştir.
İlk fixture commit'i kaynak verilerini, atıfları ve bağımsız bütünlük testini içerir.

## RFC kaynakları

İndirme tarihi: 2026-09-18.

| Kaynak | Kullanım | Özgün metnin SHA-256 özeti |
| --- | --- | --- |
| [RFC 9421, Şubat 2024](https://www.rfc-editor.org/rfc/rfc9421.txt) | B.1.4 Ed25519 anahtarı, B.2 örnek istek, B.2.6 imza tabanı ve imza | 612655786bf4293bfc486e4177571467fbb3de6e6f0eea90cb74c346a34fdf3c |
| [RFC 9651, Eylül 2024](https://www.rfc-editor.org/rfc/rfc9651.txt) | Structured Fields parser/serializer normatif kaynağı | fe27f2ec8819911afbe4bd11f6fcb947580da4c49e5423a1fff960e252ced26d |

RFC yayınlarının burada kullanılan kimliği RFC numarası, bölüm ve kaynak içerik
özetidir; bunlara ait olmayan bir Git commit kimliği verilmez. Tam metinler kendi
telif bildirimleriyle saklanır; proje MIT lisansı bu belgeleri yeniden lisanslamaz.
RFC'den çıkarılan kod bileşenleri için IETF Trust Revised BSD bildirimi korunur.
RFC errata incelemesi sırasında tespit edilen düzeltmeler özgün fixture'ları
sessizce değiştirmek yerine ayrıca kaynaklandırılmalıdır.

### Uygulanan dönüşümler

- PEM ve JWK: yalnızca yayın girintisi kaldırılır; dosya sonuna LF eklenir.
- İmza tabanı: yayın girintisi ve RFC 8792 sunum katlamaları kaldırılır.
  Katlamadan önceki anlamlı boşluk korunur; dosya sonuna LF eklenmez.
- İmza başlıkları: aynı sunum dönüşümü uygulanır; dosya sonuna LF eklenmez.
- İmza baytları: RFC'deki base64 değeri çözülür, imza yeniden hesaplanmaz.
- Örnek istek başlığı: LF içeren metinsel gösterimdir; HTTP tel biçimi değildir,
  CRLF içermez ve gövdeyi kapsamaz.
- Özgün RFC metinleri dönüştürülmeden saklanır.

B.2.6 imza tabanı 284 bayt, imza 64 bayttır. Bu sayılar ve içerik özetleri,
yanlışlıkla boşluk ya da son satır sonu eklenmesini görünür kılar.

**Yayımlanmış özel anahtar gizli değildir. Üretimde kesinlikle kullanılmamalıdır.**
Fixture anahtarı otomatik anahtar üretiminin varsayılanı olamaz.

## HTTP Working Group Structured Fields test takımı

Kaynak: https://github.com/httpwg/structured-field-tests

Sabit commit: **00462dd7938b43bf596cb2af6a373d9c928a6cbe**

Commit zamanı: 2026-09-16T11:35:13+10:00.

[Değişmez kaynak görünümü](https://github.com/httpwg/structured-field-tests/tree/00462dd7938b43bf596cb2af6a373d9c928a6cbe)

JSON test ve şema dosyaları, upstream açıklaması ve lisansı Git nesnelerinden
doğrudan bayt olarak alınmıştır. Klonun çalışma ağacındaki CRLF dönüşümleri
aktarımı etkilemez. Upstream generator veya CI betikleri çalıştırılmamıştır.
Upstream telif bildirimi ve üç koşullu BSD metni aynen korunur.

Test yükleyicisi, beklenen JSON sayılarındaki ondalık/tamsayı ayrımını korumalıdır.
Sadece JavaScript sayı değerlerine dönüştürmek, tam sayı değerli ondalıkların
beklenen serileştirmesini kaybettirebilir. Bu ayrım agentsig parser'ının
çıktısından veya serileştirilecek beklentiyi tekrar ayrıştırmaktan türetilmemelidir.
Binary beklentiler upstream biçiminde base32 olarak temsil edilir; HTTP alanının
base64 sözdizimiyle karıştırılmamalıdır.

## Bütünlük ve satır sonları

Her aktarılmış dosyanın yolu, kaynağı, bayt uzunluğu ve SHA-256 özeti
[manifestte](../tests/fixtures/manifest.json) kayıtlıdır.

[Bağımsız bütünlük testi](../tests/fixture-integrity.test.mjs):
- Dosyaları bayt olarak okuyup manifest ile karşılaştırır.
- RFC imzasını Node yerleşik kriptografisiyle doğrular; agentsig kodunu kullanmaz.
- CRLF dönüşümünün ve fazladan son LF'nin imzayı bozduğunu sınar.
- Yalıtılmış geçici Git depolarında üç otomatik satır sonu ayarıyla gerçek
  indeksleme ve checkout yapar; indeks ve çalışma ağacı özetlerini karşılaştırır.
- Kullanıcının global Git yapılandırmasını değiştirmez.

[Git attributes](../.gitattributes) metin fixture'larında LF zorlar; ikili
imza/anahtar dosyalarını dönüşümden muaf tutar. Bu ayarlar mevcut çalışma ağacını
kendiliğinden düzeltmediği için manifest kontrolü checkout öncesinde de gereklidir.

[Fixture CI matrisi](../.github/workflows/fixtures.yml) Node 20/22/24 ve
Windows/Linux üzerinde aynı testi çalıştırmak üzere tanımlanmıştır.
Yerel Windows / Node 22 çalıştırmasında beş test geçmiştir; bu, diğer matris
hücrelerinin çalıştırıldığı veya kütüphane motorunun doğrulandığı anlamına gelmez.

## Yeniden aktarım

[İçe aktarma betiği](../scripts/import-fixtures.mjs) ağdan kendiliğinden kaynak
indirmez. Önceden indirilen RFC metinlerini içerik özetleriyle, geçici upstream
klonunu sabit commit kimliğiyle kontrol eder; uyuşmazlıkta durur.
Kaynak güncellemesi açık bir fixture değişikliği, lisans incelemesi, manifest
farkı ve bağımsız bütünlük testleriyle yapılmalıdır. Beklenen çıktıları üretim
uygulamasının çıktısıyla değiştirerek testleri geçirmek kabul edilmez.
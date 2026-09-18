# WG E.2.1 bildirim taslağı — gönderilmedi

Kullanıcı tarafından gönderilecek kısa rapor. Hedef: taslak deposu veya
kullanıcının belirttiği webbotauth@ietf.org adresi; alıcı adresi gönderimden önce
güncel WG sayfasından teyit edilmelidir.

Taslak deposu: https://github.com/thibmeu/http-message-signatures-directory

## Subject

draft-ietf-webbotauth-httpsig-protocol-00: label/member mismatch in Appendix E.2.1

## Message

While checking the Ed25519 vector in Appendix E.2.1 of
draft-ietf-webbotauth-httpsig-protocol-00, we noticed that Signature-Input
and Signature use the label sig2, while Signature-Agent uses the member
key agent2. The covered Signature-Agent component also selects agent2.

This appears inconsistent with Section 5.2.1's requirement to cover the
Signature-Agent member keyed to the signature label.

The published signature is cryptographically valid: we independently
verified the published 375-byte signature base and 64-byte Ed25519
signature using the RFC 9421 Appendix B.1.4 public key. The observation
concerns profile label binding, not a cryptographic failure.

A minimal correction would be to change the labels in Signature-Input
and Signature from sig2 to agent2, and update the accompanying prose.
Those labels are not included in the signature base, so this should
preserve the published base and signature bytes.

Alternatively, if sig2 is the intended label, change the Signature-Agent
member and its covered key parameter to sig2, update the signature base,
and recompute the signature.

Could you confirm which naming is intended?

Reference:
https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#appendix-E.2.1

## Yerel test kaydı

Özgün [vektör bölümü](../tests/fixtures/m2/published/wg-E.2.1/section.txt),
[imza tabanı](../tests/fixtures/m2/published/wg-E.2.1/base.txt) ve
[imza baytları](../tests/fixtures/m2/published/wg-E.2.1/signature.bin) değiştirilmez.
[Politika fixture'ı](../tests/fixtures/m2/policy-cases.json) yalnızca etiket
bağlama aşaması için agent-label-mismatch bekler; kapsam ve zaman ihlalleri de
bulunduğundan tam doğrulayıcının ilk hatası hakkında çıkarım yapmaz.
Bu rapor başka ekler veya taslak sürümleri için genel uyumluluk iddiası içermez.
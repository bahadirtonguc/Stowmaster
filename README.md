# Stowage Planner (prototip)

Gemi ambarlarına (hold) yük yerleştiren, sezgisel bir planlama **prototipi**. Çıktısı resmi bir stowage planı değildir; stabilite, trim ve gövde dayanımı hesaplamaz.

- `src/planner.js`: yerleşim mantığı, metrikler ve CSV doğrulama (DOM bağımlılığı yok)
- `src/template.html`: tarayıcı arayüzü
- `tests/planner.test.js`: yerleşim kurallarını kontrol eden testler
- `scripts/build.js`: `planner.js`'i şablona gömüp `dist/index.html` üretir

## Çalıştırma

Yalnızca Node.js gerekir, bağımlılık yok. Node 22 ile test edildi.

    npm test        # testleri çalıştır
    npm run build   # dist/index.html üret

`dist/index.html` tek dosyadır, internet bağlantısı gerektirmez; tarayıcıda doğrudan açılır. Sayfa açılınca örnek veriyle bir plan gösterir.

Kütüphane olarak kullanım:

```js
const P = require('./src/planner.js');
const { items, errors, warnings } = P.parseCargoChecked(csvText, { holds: 3 });
if (errors.length) throw new Error(errors.map(P.formatIssue).join('\n'));
const vessel = { n: 3, L: 24, bB: 16, bT: 13, H: 12 };   // örnek değerler
const plan = P.planBest(vessel, items, 350);            // 350 t: hold başına örnek üst sınır
const metrics = P.planMetrics(vessel, plan);
```

## Veri formatı

### Hold bilgileri

Tüm hold'lar aynı ölçüdedir. Birim metre ve ton.

| Alan | Anlam |
|---|---|
| `n` | Hold sayısı (tam sayı, 0–50) |
| `L` | Hold boyu |
| `bB` | Taban genişliği (z = 0) |
| `bT` | Üst genişlik (z = H). Genişlik tabandan üste doğrusal değişir. Yukarı doğru daralan da genişleyen de olabilir. |
| `H` | Hold yüksekliği |
| max yük | Hold başına ağırlık üst sınırı (t) |

Değerler sıfır ya da pozitif sayı olmalı. Boş alan sıfır kabul edilmez, hata olarak gösterilir.

### Yük listesi (CSV)

İlk satır başlıktır. Kolonlar sırayla:

| # | Kolon | Zorunlu | Kural | Boşsa |
|---|---|---|---|---|
| 1 | `ad` | evet | boş olamaz; virgül ve tırnak içeremez | – |
| 2 | `uzunluk` | evet | sayı, > 0 (m) | – |
| 3 | `genislik` | evet | sayı, > 0 (m) | – |
| 4 | `yukseklik` | evet | sayı, > 0 (m) | – |
| 5 | `agirlik` | evet | sayı, ≥ 0 (t) | – |
| 6 | `adet` | hayır | pozitif tam sayı, en fazla 1000 | 1 |
| 7 | `oncelik` | hayır | sayı; küçük olan önce denenir | 9 |
| 8 | `istiflenebilir` | hayır | `yes` / `no` | `yes` |
| 9 | `kisit` | hayır | `H1`, `H2` … (yalnızca o hold) | kısıt yok |

```
ad,uzunluk,genislik,yukseklik,agirlik,adet,oncelik,istiflenebilir,kisit
Kutu A,1.2,0.8,0.8,0.6,20,2,yes,
Makine C,2.5,1.2,1.4,4.0,4,1,no,
Ozel yuk D,1.0,1.0,1.0,1.0,6,1,yes,H3
```

Bu satırlar ve arayüzdeki gemi ölçüleri **örnektir**, gerçek bir gemiye ya da yüke ait değildir.

**Doğrulama:** Hatalı satırlar sessizce atlanmaz. Eksik ya da fazla kolon, sayı olmayan değer (`abc`, `0x10`, `1,5`), sıfır/negatif ölçü, tam sayı olmayan adet, `yes/no` dışında değer, hatalı kısıt, eksik başlık satırı ve tırnak işareti satır ve kolon numarasıyla raporlanır. Tek bir hata varsa bile plan oluşturulmaz. Var olmayan bir hold'a kısıt (ör. 3 hold'da `H5`) hata değil uyarıdır; o kalem yerleşmez. Ondalık ayırıcı noktadır. Toplam kalem sayısı (adetler dahil) en fazla 5000 olabilir.

`parseCargo` hata varsa exception atar (`e.errors` listesiyle). `parseCargoChecked` ise `{ items, errors, warnings }` döndürür.

## Yerleşim yöntemi

- Yükler yatay katmanlara konur. Katman içinde boy boyunca şeritler halinde, orta hattan simetrik dizilir; kalem 90° döndürülebilir.
- Genişlik kontrolü, kalemin yüksekliği boyunca hold'un **en dar** genişliğiyle yapılır.
- İstiflenebilir bir kalemin üstüne, **aynı taban ölçüsündeki** istiflenebilir kalemler katman yüksekliğini aşmadan konabilir (kolon).
- İstiflenemeyen kalem yalnızca hold tabanına konur ve o hold'da daha yüksekte hiçbir kalem olmaz.
- Kısıtlı kalem yalnızca kendi hold'una, ağırlık üst sınırı aşılmadan konur.
- Bir katmanın üstündeki katman, alttakilerin oluşturduğu düz bir zemine oturur varsayılır (ara güverte/kalas gibi). Bu destek ayrıca kontrol edilmez.

`planBest` 6 sıralama × 3 katman stratejisini dener:

- **original:** katman yüksekliği, listede sıradaki ilk uygun kalemin yüksekliğidir. İlk sürümün yöntemidir.
- **columns:** original'e ek olarak katman içinde kolon istifler.
- **height-groups:** sıradaki ilk birkaç farklı yüksekliği dener ve boşluk oranı en düşük katmanı seçer. Böylece benzer yükseklikteki kalemler aynı katmanda toplanır.

En çok hacmi yerleştiren plan seçilir; eşitlikte dikey boşluğu az olan kazanır. Sonra sıralama üzerinde sabit tohumlu bir yerel arama (iki kalemi değiştirme / bir kalemi taşıma, varsayılan 150 adım) yapılır. Sonuç deterministiktir ve hiçbir zaman ilk sürümün yönteminden daha az hacim yerleştirmez. Hold'ların dolduğu 100 rastgele örnek senaryoda ortalama net hacim kullanımı %56,1'den %64,0'a çıktı.

## Metrikler

| Metrik | Tanım |
|---|---|
| Net hacim kullanımı | yük hacmi / hold hacmi |
| Dikey boşluk | her kolonun üstü ile katman tavanı arasındaki boş yükseklik × taban alanı. Katman bu hacmi tüketir ama yük taşımaz. |
| Dikey boşluk dahil kullanılan hacim | (yük hacmi + dikey boşluk) / hold hacmi |
| Katman doluluğu | yük hacmi / (yük hacmi + dikey boşluk); 1 = hiç dikey boşluk yok |
| En büyük dikey boşluk | tek bir kolondaki en büyük boş yükseklik (m) |
| Üst boşluk | en üst katmanın tavanı ile hold yüksekliği arasındaki fark (m) |

Hold hacmi yamuk kesitle hesaplanır: `L × (bB + bT) / 2 × H`. Katman içindeki yatay boşluklar (şerit sonları, daralan kenarlar) ve en üst katmanın üstündeki boşluk dikey boşluğa dahil değildir. Bunlar, boşluk dahil kullanımın %100'e ulaşmayan kısmında kalır.

## Testler

`npm test` şunları kontrol eder:

- **Kurallar:** 3B çakışma yok; boy, yükseklik ve en dar genişlik sınırları; ağırlık sınırı; kısıtlar; istiflenemeyen kalemin üstünde yük yok; katman içinde üst üste konan kalemin altında aynı tabanlı, istiflenebilir bir kalem var; hiçbir kalem kaybolmuyor ya da iki kez yerleşmiyor.
- **Metrikler:** elle hesaplanmış örnekler; NaN çıkmıyor.
- **Uç durumlar:** boş liste, sıfır kapasiteli hold (0 t, `L`/`H`/genişlik 0, 0 hold), tek kalem (sığan, sığmayan, dönerek sığan, kısıtlı), yukarı doğru genişleyen hold.
- **CSV:** her hata türü satır ve kolonuyla raporlanıyor; `parseCargo` hata varsa exception atıyor.
- **Rastgele:** sabit tohumlu 1000 senaryo; her birinde kurallar ve ilk sürümün yönteminden kötü olmama koşulu kontrol edilir.

## Sınırlar

- Örnek gemi ve yük verileri gerçek değildir. Gerçek hold ölçülerini geminin stabilite kitabından ve kapasite planından gir.
- Hold, düz duvarlı yamuk kesitli basit bir kutu olarak modellenir. Gerçek hold geometrisi (ambar ağzı, köşe tankları, çerçeveler, eğri bölgeler) modellenmez.
- Yerleşim sezgiseldir, optimum değildir. Yerel arama sınırlı sayıda adım yapar.
- Hedef yerleşen hacmi artırmaktır. Öncelik yalnızca sıralama ipucudur, garanti değildir: daha fazla hacim sığıyorsa düşük öncelikli kalemler yüksek öncelikli olanların yerine yerleşebilir.
- Katmanların üst üste oturduğu düz zemin varsayılır. Destek alanı, nokta yükü, tank üstü/güverte izin verilen yükü (t/m²) ve bağlama (lashing/securing) kontrol edilmez.
- Ağırlık merkezi, yük dağılımı ve hold'lar arası denge hesaplanmaz. Yalnızca hold başına toplam ağırlık sınırı kontrol edilir.
- Tehlikeli yük ayrımı (segregation), liman sırası ve boşaltma sırası dikkate alınmaz.
- **Stabilite, trim ve gövde dayanımı (kesme kuvveti, eğilme momenti) hesaplanmaz. Çıktı resmi stowage planı değildir; operasyon için sınıf onaylı loading computer gerekir.**

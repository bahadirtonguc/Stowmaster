# Stowage Planner (prototip)

Gemi ambarlarına (hold) yük yerleştiren, sezgisel bir planlama **prototipi**. Çıktısı resmi bir stowage planı değildir; stabilite, trim ve gövde dayanımı hesaplamaz.

- `src/planner.js`: yerleşim mantığı, ağırlık kuralları, şekiller, metrikler ve CSV doğrulama (DOM bağımlılığı yok)
- `src/drawing.js`: teknik çizimdeki iki görünüşten siluet ve 3B şekil çıkarma (DOM bağımlılığı yok)
- `src/template.html`: tarayıcı arayüzü
- `tests/`: `planner.test.js` ve `drawing.test.js` (`npm test`), `e2e.js` (tarayıcı testi, isteğe bağlı)
- `scripts/build.js`: `planner.js` ve `drawing.js`'i şablona gömüp `dist/index.html` üretir

## Çalıştırma

Yalnızca Node.js gerekir, bağımlılık yok. Node 22 ile test edildi.

    npm test           # testleri çalıştır
    npm run build      # dist/index.html üret
    npm run test:e2e   # isteğe bağlı: tarayıcı testi (Playwright + Chromium kurulu olmalı)

`dist/index.html` tek dosyadır ve tarayıcıda doğrudan açılır. Sayfa açılınca örnek veriyle bir plan gösterir. İnternet yalnızca PDF çizim açarken gerekir: PDF okuyucu (pdf.js 3.11.174) o anda `cdnjs.cloudflare.com`'dan yüklenir. Çevrimdışıyken çizimi PNG ya da JPG olarak yükle.

Tarayıcı testi PDF adımı için pdf.js'i internetten çeker; çevrimdışı çalıştırmak için `PDFJS_DIR` ile `pdfjs-dist@3.11.174/build` klasörünü göster (yoksa PDF adımı atlanır).

Kütüphane olarak kullanım:

```js
const P = require('./src/planner.js');
const { items, errors, warnings } = P.parseCargoChecked(csvText, { holds: 3, shapes: {} });
if (errors.length) throw new Error(errors.map(P.formatIssue).join('\n'));
const vessel = { n: 3, L: 24, bB: 16, bT: 13, H: 12 };   // örnek değerler
const rules = { balanceHolds: true, balancePortStbd: true, heavyBelow: true, floorLoad: 10 };
const plan = P.planBest(vessel, items, 350, { rules });  // 350 t: hold başına örnek üst sınır
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
| taban yük sınırı | İsteğe bağlı, t/m² (bkz. Ağırlık kuralları) |

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
| 10 | `ust_yuk` | hayır | sayı, ≥ 0 (t): kalemin üstüne binebilecek en fazla ağırlık | sınır yok |
| 11 | `sekil` | hayır | `kutu`, `silindir` ya da `cizim` | `kutu` |
| 12 | `yatis` | silindirde evet | `dik`, `boyuna` ya da `enine` | – |

Eski 9 kolonlu listeler aynen çalışır.

**Silindir:** `uzunluk` eksen boyu, `genislik` ve `yukseklik` çaptır (eşit olmalı). Yatış yönü zorunludur; boş bırakılırsa plan yapılmaz ve "yatış yönünü seç" hatası verilir. `dik`: eksen dikey. `boyuna`: eksen hold boyunca. `enine`: eksen hold enine. Yatık silindir döndürülmez, ekseni seçilen yönde kalır.

**Çizim (`cizim`):** Şekil, aynı `ad` için arayüzde yüklenen çizimden gelir (bkz. Çizimden şekil). Çizim yüklenmemişse satır hata verir.

```
ad,uzunluk,genislik,yukseklik,agirlik,adet,oncelik,istiflenebilir,kisit,ust_yuk,sekil,yatis
Kutu A,1.2,0.8,0.8,0.6,20,2,yes,,,,
Palet B,1.2,1.0,1.1,0.9,15,2,yes,,2,,
Celik bobin,1.5,2.0,2.0,8.0,4,3,no,,,silindir,dik
Boru,6.0,0.6,0.6,1.2,6,2,yes,,,silindir,boyuna
Makine E,4,2,3,6,2,1,yes,,,cizim,
```

Bu satırlar ve arayüzdeki gemi ölçüleri **örnektir**, gerçek bir gemiye ya da yüke ait değildir.

**Doğrulama:** Hatalı satırlar sessizce atlanmaz. Eksik ya da fazla kolon, sayı olmayan değer (`abc`, `0x10`, `1,5`), sıfır/negatif ölçü, tam sayı olmayan adet, `yes/no` dışında değer, hatalı kısıt, hatalı `ust_yuk`/`sekil`/`yatis`, silindirde eşit olmayan çap, yüklenmemiş çizim, eksik başlık satırı ve tırnak işareti satır ve kolon numarasıyla raporlanır. Tek bir hata varsa bile plan oluşturulmaz. Var olmayan bir hold'a kısıt (ör. 3 hold'da `H5`) hata değil uyarıdır; o kalem yerleşmez. Ondalık ayırıcı noktadır. Toplam kalem sayısı (adetler dahil) en fazla 5000 olabilir.

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

## Ağırlık kuralları

Arayüzde varsayılan olarak açıktır; kütüphanede `opts.rules` ile açılır. Bunlar yalnızca **yerleşim** kurallarıdır; stabilite, trim ya da gövde dayanımı hesabı değildir.

| Kural | Ne yapar |
|---|---|
| Hold'lar arası denge (`balanceHolds`) | Hold'lar katman katman, her seferinde en hafif hold'dan devam ederek doldurulur. Önce her hold'a toplam ağırlığın eşit payı kadar tavan konur, kalan yük sonra tam sınırla üst katmanlara yerleşir. |
| İskele/sancak dengesi (`balancePortStbd`) | Her şerit hafif taraftan başlar. Katman bitince her şerit, ağırlık kuralları bozulmuyorsa, hold'un enine momentini sıfıra yaklaştıracak şekilde enine kaydırılır. |
| Ağır alta, hafif üste (`heavyBelow`) | Bir kalem kendisinden hafif bir kalemin doğrudan üstüne konmaz. |
| Taban yük sınırı (`floorLoad`, t/m²) | Her kalemin ağırlığı kendi taban alanından dikey olarak hold tabanına iner kabul edilir; tabanın hiçbir noktasında toplam bu sınırı aşamaz. |
| Üst yük sınırı (`ust_yuk` kolonu, t) | Kalemin üstüne binen toplam ağırlık (aynı dikey izdüşüm varsayımıyla, örtüşen alan oranında) bu sınırı aşamaz. `0`: üstüne hiçbir şey konmaz. |

Kurallar her aday plan için kesin sınırdır; `planBest` bu sınırlar içinde en çok hacmi arar. Örnek senaryolarda:
- Hold dengesi ağırlık farkını belirgin biçimde düşürdü (yalnız istiflenebilir yükle bir örnekte 255 t'den 1,2 t'ye).
- Tüm kurallar birlikte açıkken 300 senaryoda hold'ların enine moment toplamı 14 962 t·m'den 615 t·m'ye indi.
- Hold dengesi ve iskele/sancak kuralı yerleşen hacmi azaltmadı.
- "Ağır alta" kuralı ortalama net kullanımı yaklaşık 3,5 puan düşürdü (%58,6 → %55,0).

## Çizimden şekil

Dikdörtgen prizma olmayan kalemler için:

1. Yük listesinde kaleme `sekil=cizim` yaz, `uzunluk`/`genislik`/`yukseklik` alanlarına dış ölçüleri gir.
2. "Çizimler" bölümünde PDF ya da görsel yükle (PDF'te sayfa seçilebilir), kalemi listeden seç.
3. Üst görünüşü, sonra yan görünüşü fareyle dikdörtgen içine al. Bulunan siluet çizimin üstünde renkli gösterilir.
   - Üst görünüşte boy yatay, genişlik dikey olmalı.
   - Yan görünüşte boy yatay, yükseklik yukarı olmalı.
   - Değilse ↻ ile döndür.
4. Önizlemede iki görünüşün ızgarası ve 3B şekil görünür. "Şekli bu kaleme kaydet" ile kaydet. Şekiller yalnızca bu tarayıcıda saklanır.

Nasıl çalışır (`src/drawing.js`):
1. Seçilen alanda koyu pikseller mürekkep sayılır ve küçük kopukluklar kapatılır. "Renkli çizgileri yok say" açıksa (varsayılan) renkli pikseller kâğıt sayılır. Birçok CAD çiziminde parça siyah, ölçü, balon ve eksen çizgileri ise renkli çizilir; bu seçenek onları ayıklar. Siyah-beyaz çizimlerde etkisi yoktur.
2. Dışarıdan ulaşılamayan her şey parça kabul edilir; konturun içi dolar.
3. İnce çizgiler (ölçü, yazı, ok) temizlenir ve en büyük parça alınır.
4. İki siluet 32×32 ızgaraya örneklenir. 3B şekil, iki görünüşe de uyan **en büyük** hacimdir: bir hücre, üst görünüşte ve yan görünüşte dolu ise doludur.

Sonuç:
- Konturu her yerde kapalı çizilmiş bir parçada şekil gerçek parçadan küçük çıkmaz.
- Örnekleme ve kontur kalınlığı yüzünden biraz büyük çıkar: testteki L parçada %75 yerine yaklaşık %78–81.
- İki görünüşte görünmeyen girinti ve delikler dolu sayılır.
- Konturu açık ya da çok ince çizilmiş bir bölüm (ör. ince bir boru) siluete girmeyebilir. O bölümde şekil gerçekte olduğundan küçük kalır. Önizlemede renkli siluete bakıp kontrol et.

Ölçüler çizimden **okunmaz**; listeden alınır. Çizimin oranları listedeki ölçülerle %10'dan fazla farklıysa ya da iki görünüşte boy farklı çıkarsa uyarı verilir.

Ölçü ve uzatma çizgileri konturla kapalı bir kutu oluşturursa ya da bir balon veya yazı parçaya çok yakın durursa, bunlar da parça sanılır. Önizlemede renkli siluete bakarak bunu görürsün; oranlar listeyle tutmazsa uygulama da uyarır. Düzeltme yolları:
- Alanı konturun hemen dışından sıkı seç. Seçim kutusu yalnızca parçayı kapsamalı.
- Ölçü çizgileri renkliyse "Renkli çizgileri yok say"ı açık tut.
- "En ince kontur" ayarını artır. Görünür kontur ölçü çizgilerinden kalın çizilmişse, verilen kalınlıktan ince çizgiler doldurmadan önce yok sayılır.
- "İnce ayrıntı temizleme" değerini artır. Parçaya ince bir bağla yapışan balon ve yazılar kopar, ama parçanın ince kısımları da aşınır.

Gerçek bir çizimle deneme: bir motor ölçü çizimi (A3 PDF, beş görünüşlü, yüzlerce ince çizgi ve balon) üzerinde ortadaki yan görünüş ile alttaki üst görünüş seçildi. Renkli çizgiler yok sayılınca:
- Çizimin oranlarından çıkan genişlik ve yükseklik, çizimdeki ölçülerle %1 içinde tuttu.
- Üst görünüş kutusu birkaç balonu da kapsayınca genişlik %11 fazla çıktı ve uygulama uyardı. Kutu balonların altından başlatılınca uyarı kalktı.
- Motor (dış kutusunun %65'i) hold'a yerleştirildi.

O çizim telif hakkı korumalı olduğu için depoya eklenmedi.

Yerleşimde şekilli kalem **dış kutusuyla** yer kaplar. Şeklin içindeki boşluk (ör. L parçanın kısa tarafının üstü) şimdilik başka yükle doldurulmaz. Bu hacim "silindir/çizim kutusu içindeki boşluk" olarak ayrıca raporlanır. Silindir ve çizimli kalemlerin üstüne katman içinde kolon kurulmaz.

## Metrikler

| Metrik | Tanım |
|---|---|
| Net hacim kullanımı | yük hacmi / hold hacmi |
| Dikey boşluk | her kolonun üstü ile katman tavanı arasındaki boş yükseklik × taban alanı. Katman bu hacmi tüketir ama yük taşımaz. |
| Dikey boşluk dahil kullanılan hacim | (dış kutu hacmi + dikey boşluk) / hold hacmi |
| Silindir/çizim kutusu içindeki boşluk | dış kutu hacmi − gerçek şekil hacmi (silindirde kutunun %21,5'i) |
| Katman doluluğu | yük hacmi / (dış kutu hacmi + dikey boşluk); 1 = hiç boşluk yok |
| Ağırlık, iskele/sancak ağırlığı | hold başına; orta hattı geçen kalem taban alanı oranında bölünür |
| Ağırlık merkezinin orta hattan kaçıklığı | Σ(ağırlık × enine konum) / Σ ağırlık, m. Yalnızca yerleşim göstergesidir. |
| Hold'lar arası ağırlık farkı | en ağır hold − en hafif hold, t |
| En yüksek taban basıncı | dikey izdüşüm varsayımıyla tabanın en yüklü noktası, t/m² |
| En büyük dikey boşluk | tek bir kolondaki en büyük boş yükseklik (m) |
| Üst boşluk | en üst katmanın tavanı ile hold yüksekliği arasındaki fark (m) |

Hold hacmi yamuk kesitle hesaplanır: `L × (bB + bT) / 2 × H`. Katman içindeki yatay boşluklar (şerit sonları, daralan kenarlar) ve en üst katmanın üstündeki boşluk dikey boşluğa dahil değildir. Bunlar, boşluk dahil kullanımın %100'e ulaşmayan kısmında kalır.

## Testler

`npm test` şunları kontrol eder:

- **Kurallar:** 3B çakışma yok; boy, yükseklik ve en dar genişlik sınırları; ağırlık sınırı; kısıtlar; istiflenemeyen kalemin üstünde yük yok; katman içinde üst üste konan kalemin altında aynı tabanlı, istiflenebilir bir kalem var; hiçbir kalem kaybolmuyor ya da iki kez yerleşmiyor.
- **Metrikler:** elle hesaplanmış örnekler; NaN çıkmıyor.
- **Uç durumlar:** boş liste, sıfır kapasiteli hold (0 t, `L`/`H`/genişlik 0, 0 hold), tek kalem (sığan, sığmayan, dönerek sığan, kısıtlı), yukarı doğru genişleyen hold.
- **CSV:** her hata türü satır ve kolonuyla raporlanıyor; `parseCargo` hata varsa exception atıyor.
- **Ağırlık kuralları:** her kural için ayrı, planlayıcıdan bağımsız yazılmış kontrol; taban basıncı metriği kaba kuvvetle doğrulanır; kurallar açıkken 300 rastgele senaryo.
- **Şekiller:** iki görünüşten hacim, silindir yönünün korunması, şekilli kalemlerin üstüne kolon kurulmaması, CSV hataları (yatış yönü sorma dahil).
- **Çizim:** ölçü çizgileri, oklar, yazı, tarama, gizli ve eksen çizgileri olan sentetik bir L parça çiziminden siluet ve hacim; konturla kutu oluşturan ölçü çizgisi durumu.
- **Rastgele:** sabit tohumlu 1000 senaryo (silindir ve çizimli kalemler dahil); her birinde kurallar ve ilk sürümün yönteminden daha az gerçek yük hacmi yerleştirmeme koşulu kontrol edilir.
- **Tarayıcı (`npm run test:e2e`):**
  - örnek plan
  - yatış yönü sorma
  - örnek çizim
  - PDF ve PNG yükleyip görünüşleri fareyle seçme
  - şekillerin sayfa yenilenince korunması

## Sınırlar

- Örnek gemi ve yük verileri gerçek değildir. Gerçek hold ölçülerini geminin stabilite kitabından ve kapasite planından gir.
- Hold, düz duvarlı yamuk kesitli basit bir kutu olarak modellenir. Gerçek hold geometrisi (ambar ağzı, köşe tankları, çerçeveler, eğri bölgeler) modellenmez.
- Yerleşim sezgiseldir, optimum değildir. Yerel arama sınırlı sayıda adım yapar.
- Hedef yerleşen hacmi artırmaktır. Öncelik yalnızca sıralama ipucudur, garanti değildir: daha fazla hacim sığıyorsa düşük öncelikli kalemler yüksek öncelikli olanların yerine yerleşebilir.
- Katmanların üst üste oturduğu düz zemin varsayılır. Gerçek destek alanı, nokta yükleri ve bağlama (lashing/securing) kontrol edilmez.
- Taban yük sınırı ve üst yük sınırı basit dikey izdüşüm varsayımıyla kontrol edilir. Yük ara katmanlardan farklı dağılabilir. Yatık silindirin hat temasını, takoz/beşik ve kalas düzenini modellemez. Tank üstü izin verilen yükünün yerine geçmez.
- Ağırlık kuralları yalnızca yerleşimi yönlendirir. Gemi ağırlık merkezi (KG, LCG, TCG), meyil, trim ve boyuna yük dağılımı hesaplanmaz; boyuna (baş-kıç) denge hiç gözetilmez.
- Çizimden şekil iki görünüşten tahmin edilir. Delik, girinti ve iç boşluklar dolu sayılabilir. Çizim ölçüsü okunmaz. Şekilli kalemler yerleşimde dış kutularıyla yer kaplar; şeklin içindeki boşluk kullanılmaz.
- Çizim okuma, düzgün taranmış ya da CAD'den çıkmış net çizimler içindir. Elle çizilmiş, eğik taranmış ya da çok kalabalık paftalarda seçimi elle düzeltmek gerekebilir.
- Tehlikeli yük ayrımı (segregation), liman sırası ve boşaltma sırası dikkate alınmaz.
- **Stabilite, trim ve gövde dayanımı (kesme kuvveti, eğilme momenti) hesaplanmaz. Çıktı resmi stowage planı değildir; operasyon için sınıf onaylı loading computer gerekir.**

# Stowage Planner (prototip)

Gemi ambarlarına yük yerleştiren, sezgisel bir planlama prototipi.

- `src/planner.js`: yerleşim mantığı (DOM bağımlılığı yok)
- `src/template.html`: tarayıcı arayüzü
- `tests/`: yerleşim kurallarını kontrol eden testler
- `scripts/build.js`: `dist/index.html` üretir

## Kullanım

    npm test        # testleri çalıştır
    npm run build   # dist/index.html üret, tarayıcıda aç

## Sınırlar

- Örnek gemi ve yük verileri gerçek değildir. Gerçek hold ölçülerini geminin stabilite kitabından gir.
- Yerleşim sezgiseldir, optimum değildir.
- Stabilite, trim ve gövde dayanımı hesaplanmaz. Çıktı resmi stowage planı değildir; operasyon için sınıf onaylı loading computer gerekir.

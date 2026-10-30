# ✂️ Scene Cutter

Videolardaki sahneleri otomatik bulan, kare kare gösteren ve seçtiğiniz bölümleri **tek bir MP4 dosyası** olarak dışa aktaran masaüstü programı. Electron + FFmpeg ile yapılmıştır.

## Öne çıkanlar

- **Otomatik sahne tespiti** – FFmpeg'in sahne filtresiyle kesim noktalarını bulur, hassasiyet ayarlanabilir.
- **Filmstrip (kare kare şerit)** – Video ile timeline arasında, oynatma konumunun çevresindeki kareleri tek tek gösterir. Sahne geçişini kare kare görüp elle kesmek kolaydır.
- **Güvenilir export** – Çıktı her zaman **H.264 + AAC .mp4**'tür; çözünürlük, bitrate ve kare hızı kaynakla aynıdır. FFmpeg'in açabildiği her videoyla (MKV, AVI, MPEG, MXF, TS …) çalışır.
- **GPU desteği** – NVIDIA (NVENC), Intel (Quick Sync) ve AMD (AMF) ekran kartları otomatik algılanır; yoksa işlemci (x264) kullanılır.
- **Otomatik dosya adı** – Export'ta ad kendiliğinden `film_kesim_1.mp4`, `film_kesim_2.mp4`, … diye ilerler.
- **Önizleme proxy'si** – Tarayıcının oynatamadığı formatlar (MPEG-1/2, DivX …) için düşük kaliteli bir önizleme üretilir; export her zaman orijinal dosyadan yapılır.

## Kurulum ve çalıştırma

[Node.js](https://nodejs.org/) 18 veya üstü gerekir.

```bash
npm install
npm start
```

Windows için taşınabilir `.exe` üretmek:

```bash
npm run dist
```

Çıktı `dist/` klasöründe `SceneCutter-portable.exe` adıyla oluşur. FFmpeg ve FFprobe pakete dahildir, ayrıca kurmanız gerekmez.

## Kullanım

1. **📂 Open** ile bir video seçin veya dosyayı pencereye sürükleyin.
2. Sahneleri çıkarın:
   - **🔍 Analyze All** – bütün videoyu tarar.
   - **🎯 Analyze Range** – oynatma konumunun ±2,5 dakikası çevresini tarar.
   - **🎬 Analyze Scene** (`S`) – yalnızca oynatma çizgisinin altındaki sahneyi bulur, hızlıdır.
   - Sağdaki **Sensitivity** kaydırıcısı hassasiyeti belirler; değer düştükçe daha fazla sahne bulunur.
   - Otomatik tespit istemezseniz doğrudan elle de kesebilirsiniz (aşağıya bakın).
3. Timeline'daki sahne kutularına **tıklayarak** dışa aktarmak istediklerinizi seçin (seçili olanlar parlak görünür). Çift tık, sahneyi baştan oynatır.
4. Gerekirse kesim noktalarını düzeltin (aşağıda).
5. **✂️ Export MP4**'e basın. Kayıt penceresi bir sonraki boş adla (`..._kesim_1.mp4`, `_2`, `_3` …) açılır, istediğiniz gibi değiştirebilirsiniz. Dosya, orijinalin bulunduğu klasörü önerir.

Birbirine bitişik seçili sahneler tek parça olarak birleştirilir. Birden fazla ayrık parça seçerseniz çıktı hepsini sırayla arka arkaya içerir.

### Filmstrip ile elle kesim

Filmstrip, kesim noktasını kare hassasiyetiyle bulmanız içindir. Oynatma konumu daima ortadadır, sol ve sağda komşu kareler sıralanır.

- **Fare tekerleği** – bir kare ileri/geri (**Shift** ile 10 kare).
- **Sürükleme** – filmi çeker gibi kaydırır.
- **Tıklama** – o kareye atlar.
- Sağ üstteki **Step** menüsü karelerin aralığını 1, 2, 5, 10 veya 25 kare yapar. Aralık büyütülünce uzun bir bölgede geçişi bulmak kolaylaşır, sonra 1 kareye inip hassas ayar yapılır.
- Beyaz çizgiler sahne sınırlarını, alttaki renkli şerit sahnelerin kapsadığı yeri gösterir.

Kesim noktasını belirlemek için:

1. Filmstrip ile istediğiniz kareye gelin.
2. **Add Trim** (`C`) – oynatma konumuna yeni bir kesim çizgisi koyar (sahneyi ikiye böler).
   **Snap Trim** (`T`) – en yakın mevcut kesim çizgisini oynatma konumuna taşır.
   **Add Segment** – hiç sahne yokken konumdan itibaren yeni bir parça başlatır.
3. Kesim çizgilerini timeline'da sürükleyerek de ayarlayabilirsiniz. Sahne kutusuna sağ tıklayınca baş/son noktasını oynatma konumuna ayarlama ve kesim çizgisini kaldırma seçenekleri çıkar.

### Video üzerinde gezinme

- Videonun üstünde **fare tekerleği** bir tıkta 2 saniye ileri/geri sarar (Shift ile tek kare). Alt taraftaki ilerleme çubuğu, filmstrip ve timeline anında takip eder.
- Timeline üzerinde tekerlek kaydırır, **Ctrl + tekerlek** yakınlaştırır.

## Klavye kısayolları

| Tuş | İşlev |
|-----|-------|
| `Boşluk` | Oynat / duraklat |
| `,` `.` veya `←` `→` | Bir kare geri / ileri (Shift ile 10 kare) |
| `C` | Oynatma konumundan kes (Add Trim) |
| `T` | En yakın kesim çizgisini oynatma konumuna taşı (Snap Trim) |
| `S` | Oynatma çizgisindeki sahneyi bul (Analyze Scene) |
| `↑` `↓` | Ses aç / kıs |
| `M` | Sesi kapat / aç |
| `F` | Tam ekran |
| `Ctrl + Z` | Geri al |
| `Ctrl + tekerlek` | Timeline'ı yakınlaştır |

## Export nasıl çalışır?

Önceki sürümlerde kayıpsız kesim (stream copy) ve "Smart Cut" modları vardı. Bunlar anahtar karelere, codec parametrelerine ve konteyner farklarına bağımlı olduğundan bazı videolarda hata veriyor veya donuyordu. Artık tek bir yöntem var ve her videoda aynı şekilde çalışır:

- Seçilen bölümler **tek bir FFmpeg işleminde** kesilir, birleştirilir ve yeniden encode edilir. Kesimler kare hassasiyetindedir, ses aynı işlemde kesildiği için görüntüyle kaymaz.
- **Çözünürlük** aynı kalır (yalnızca tek sayılı boyutlar H.264 gereği bir piksel aşağı yuvarlanır). **Kare hızı** aynıdır, **video bitrate'i** kaynağınkine eşitlenir (en çok 100 Mbit/s).
- Ses AAC'ye, 4:2:0 piksel formatına ve `+faststart` MP4'e dönüştürülür.
- Encoder önce ekran kartında denenir (NVENC → Quick Sync → AMF). Kart yoksa ya da GPU encode hata verirse otomatik olarak işlemciye (x264, `preset fast`) geçer. İlerleme satırında hangisinin kullanıldığı yazar.

**Sınırlar:**

- Yalnızca ilk ses kanalı alınır, altyazılar çıktıya eklenmez.
- HDR / 10-bit videolar 8-bit'e dönüştürülür.
- Yeniden encode olduğu için kayıpsız değildir; ancak aynı bitrate'te, özellikle eski codec'lerden (MPEG-2, DivX) gelen videolarda kalite genelde korunur veya iyileşir.
- GPU encode CPU'dan genelde birkaç kat hızlıdır, aynı bitrate'te kalite biraz daha düşük olabilir. Kaliteyi artırmak için `exporter.js` içindeki `BITRATE_FACTOR` değerini yükseltin (örn. `1.2`). GPU'yu hiç kullanmak istemezseniz `exportScenes` çağrısında `forceCpu: true` verin.

## Önizleme önbelleği

Tarayıcının oynatamadığı bir format açıldığında program düşük çözünürlüklü bir önizleme dosyası üretir ve sadece oynatmada kullanır. **🗂 Preview Cache** düğmesinden bu dosyaların yerini ve boyutunu görebilir, klasörü açabilir veya temizleyebilirsiniz. Export bu önizlemeden değil, her zaman orijinalden yapılır.

## Sorun giderme

| Sorun | Çözüm |
|-------|-------|
| Export hata veriyor | Durum satırının üzerine gelince ayrıntılı FFmpeg mesajı görünür. Kaynak ve hedef dosya aynı olamaz. |
| Export çok yavaş | Ekran kartı algılanmamış olabilir (satırda "CPU · x264" yazar). Güncel ekran kartı sürücüsünü kurun. |
| Filmstrip kareleri bir an boş geliyor | Kareler arka planda üretilir; çok uzun videolarda ilk yükleme veya uzak bir yere atlama birkaç yüz milisaniye sürebilir. Yüklenene kadar önceki görüntü soluk görünür. |
| Video oynatılmıyor ama önizleme de gelmiyor | Dosyanın video akışı FFmpeg tarafından okunamıyordur. Başka bir kopyasıyla deneyin. |

## Dosya yapısı

| Dosya | İçerik |
|-------|--------|
| `main.js` | Electron ana süreç: pencereler, FFmpeg/FFprobe çağrıları, sahne tespiti, filmstrip kareleri |
| `exporter.js` | Export motoru (Electron'dan bağımsız, doğrudan Node ile çalıştırılabilir) |
| `renderer.js` | Arayüz: oynatıcı, timeline, filmstrip, export düğmeleri |
| `preload.js` | Arayüz ile ana süreç arasındaki güvenli köprü |
| `index.html` | Sayfa yapısı ve stiller |

## Lisans

MIT

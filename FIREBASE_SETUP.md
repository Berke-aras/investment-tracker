# Firebase Kurulum Rehberi

Bu rehber PortfolioTrack uygulamasini Firebase Auth ve Firestore ile calistirmak icin gereken adimlari aciklar.

## 1. Firebase Projesi Olusturma

1. [Firebase Console](https://console.firebase.google.com/) adresine gidin.
2. "Add project" ile yeni proje olusturun.
3. Proje ayarlari tamamlandiginda sol menuden **Project Settings** > **General** > **Your apps** > **Web** (</>)  ikonuna tiklayin.
4. Uygulama adini girin (orn: `PortfolioTrack`) ve "Register app" tiklayin.
5. Gosterilen `firebaseConfig` nesnesindeki degerleri `js/firebase-config.js` dosyasina kopyalayin.

## 2. Authentication Ayarlari

1. Firebase Console > **Authentication** > **Sign-in method** sekmesine gidin.
2. **Anonymous** saglayiciyi aktif edin (Enable).
3. **Google** saglayiciyi aktif edin.
4. **Settings** > **Authorized domains** bolumune GitHub Pages domain'inizi ekleyin:
   - `YOUR_USERNAME.github.io`
   - Eger project page kullaniyorsaniz, tam URL'yi de test edin.

## 3. Cloud Firestore Olusturma

1. Firebase Console > **Firestore Database** > **Create database** tiklayin.
2. Konum secin (orn: `europe-west1` veya `us-central`).
3. "Start in **production mode**" secin.
4. Olusturulduktan sonra **Rules** sekmesine gidin.
5. Kurallari asagidakiyle degistirin (veya repo'daki `firestore.rules` dosyasini kullanin):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

6. **Publish** tiklayin.

## 4. firebase-config.js Dosyasini Duzenleme

`js/firebase-config.js` dosyasini acin ve Firebase Console'dan aldiginiz degerlerle doldurun:

```js
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyB...",
    authDomain: "my-project.firebaseapp.com",
    projectId: "my-project",
    storageBucket: "my-project.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abc123"
};
```

> Bu degerler tarayici tarafinda calisir ve public repo'da bulunmalari guvenlidir.
> Gercek guvenlik Firestore kurallari ve Auth ile saglanir.

## 5. GitHub Pages Yayinlama

1. Repo'yu GitHub'a push edin.
2. **Settings** > **Pages** > **Source**: `main` branch, `/ (root)` secin.
3. Birkas dakika sonra `https://YOUR_USERNAME.github.io/investment-tracker/` adresinde yayinda olacaktir.

## 6. Test

- Sayfayi acin, otomatik olarak anonim oturum baslar.
- "Google ile Giris" butonuyla Google hesabinizla baglanin.
- Varlik ekleyin, farkli cihazdan ayni hesapla giris yaparak verilerin senkron oldugunu dogrulayin.

## Veri Yapisi (Firestore)

```
users/
  {uid}/
    portfolio/
      state  ->  {
        assets: [...],
        history: { assetId: [...] },
        historyMeta: { assetId: {...} },
        userName: "...",
        updatedAt: Timestamp,
        schemaVersion: 2
      }
```

Her kullanici yalnizca kendi `users/{uid}` belgesini okuyabilir/yazabilir.

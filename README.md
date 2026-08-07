# CVDoctor SDK

[CVDoctor](https://cvdoctor.io) のブラウザ用計測・A/Bテスト適用SDKです。**MITライセンス**で公開しています。

計測タグは、設置した瞬間から訪問者のブラウザで動きます。何を送っていて、何を送っていないかは、説明文ではなくコードで確認できるべきだと考えています。このリポジトリはそのために存在します。

- 依存ゼロ・ビルド不要のバニラJS（IIFE）
- Cookieを使わない（localStorage とメモリのみ）
- 入力値・氏名・メールアドレス全体・電話番号を**一切送信しない**
- 同意前のイベントはバッファに溜め、同意後にのみ送信する

---

## 設置

```html
<script async src="https://cvdoctor.io/sdk/cvdoctor.js" data-site-id="YOUR_ORG_ID"></script>
```

自前の同意管理バナーを使っている場合は、SDK内蔵のバナーを抑止して外部UIに委譲できます。

```html
<script
  async
  src="https://cvdoctor.io/sdk/cvdoctor.js"
  data-site-id="YOUR_ORG_ID"
  data-consent="external"
></script>

<script>
  // 自前のバナーで「同意」が押されたら
  window.cvdoctor.setConsent(true);
</script>
```

## API

| 呼び出し | 説明 |
| --- | --- |
| `window.cvdoctor.init(config)` | 任意の設定上書き |
| `window.cvdoctor.track({ type, metadata })` | 任意イベント送信。`type` は `impression` \| `click` \| `conversion` |
| `window.cvdoctor.setConsent(boolean)` | 外部同意UIとの連携（`data-consent="external"` 時） |

`identify()` は提供していません。個人を識別するための関数を置かないこと自体が設計方針です。

---

## 何を送るか / 送らないか

### 送るもの

| 種類 | 中身 |
| --- | --- |
| ページイベント | ページURL、`impression`/`click`/`conversion` の別、匿名の訪問者ID・セッションID、リファラ、デバイス種別（mobile / desktop / tablet の3分類のみ） |
| フォーム進行 | フォームID、フィールド**名**（`name`/`id` 属性）、何番目のステップか、到達したか、離脱したか |
| リード品質シグナル | 入力済みフィールドの**数**、メールドメインの**種別**（`corporate` / `free` / `unknown` の3値）、会社名フィールドの有無、フォーム操作の所要ミリ秒 |
| A/Bテスト | 割り当てられたバリアントID、表示・CV の発生 |
| 同意 | 同意したか否かと、その時刻 |

### 送らないもの

- **入力値そのもの**（氏名・会社名・電話番号・自由記述・その他あらゆるフィールドの値）
- **メールアドレス**。`@` より後ろのドメインだけを見て「企業ドメインか、フリーメールか」を判定し、**判定結果の3値だけ**を送ります。ローカルパート（`@` の前）は判定にも送信にも使いません（`emailDomainType()` を参照）
- **Cookie**。訪問者IDは `localStorage` に保存します（キー: `cvdoctor_vid` / `cvdoctor_sid` / `cvdoctor_consent` / `cvdoctor_st_*`）
- **フィンガープリント**。Canvas・フォント・WebGL等による端末識別はしません。UAは3分類の判定にのみ使い、UA文字列自体は送りません

> ⚠️ 例外は `track()` の `metadata` です。ここはサイト運営者が自由に値を入れられるため、SDKは中身を検査しません。**個人情報を入れないでください。**

### 同意ゲート

同意が確認できるまで、イベントはメモリ上のバッファに溜まるだけで送信されません。`analytics` の同意が得られた時点でまとめて送信します。同意しないまま離脱した訪問者のデータは、どこにも送られません。

---

## A/Bテストの適用範囲

DOM への適用は **text / attribute / style の3種類だけ**です。`html` の差し込みや任意JSの実行はサポートしません（`applyChange` を参照）。サーバ側でも同じ制約でサニタイズしています。

これは機能不足ではなく、意図的な上限です。AIが生成した変更をサイトに適用する以上、任意のHTML/JSを注入できる経路を作らないことがXSSに対する恒久的な答えになります。この制約を緩めるつもりはありません。

---

## ライセンス

[MIT](./LICENSE) © 2026 Rivership

このSDK（ブラウザで動く部分）はMITです。CVDoctorのサーバ・ダッシュボード・AI診断エンジンはこのリポジトリには含まれず、オープンソースではありません。

## 関連

- 製品サイト: https://cvdoctor.io
- ドキュメント: https://cvdoctor.io/docs

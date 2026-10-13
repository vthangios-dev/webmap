# map.vthangios.xyz - Webmap

Thư mục này là webmap tách riêng để deploy lên SSH.

## 1) Cài đặt

```bash
cd webmap
cp .env.example .env
npm install
```

## 2) Chạy local

```bash
npm run dev
```

- Health check: `http://localhost:3016/health`
- Viewer URL: `http://localhost:3016/`
- Hoặc vào `http://localhost:3016/webmap` rồi nhập **mã map** trên giao diện (mã này tạo từ menu app)

## 3) API ingest realtime

`POST /api/ingest/:matchId`

Header:

- `Content-Type: application/json`

Body mẫu:

```json
{
  "ts": 1728838800000,
  "meta": {
    "selfTeam": 1
  },
  "entities": [
    { "id": "self", "name": "Me", "team": 1, "x": 0.22, "y": 0.44, "hp": 9450, "maxHp": 9450, "dead": false, "visible": true },
    { "id": "enemy-1", "name": "Enemy A", "team": 2, "x": 0.61, "y": 0.52, "hp": 5100, "maxHp": 7000, "dead": false, "visible": true }
  ]
}
```

`mapFrame` (tuỳ chọn) để stream minimap thật từ game:

```json
{
  "mapFrame": {
    "mime": "image/jpeg",
    "data": "<base64>",
    "w": 320,
    "h": 320,
    "ts": 1728838800456
  }
}
```

Test nhanh:

```bash
curl -X POST "http://localhost:3016/api/ingest/test-match" \
  -H "Content-Type: application/json" \
  -d '{"ts":1728838800000,"meta":{"selfTeam":1},"entities":[{"id":"self","name":"Me","team":1,"x":0.22,"y":0.44,"hp":9450,"maxHp":9450,"dead":false},{"id":"enemy-1","name":"Enemy A","team":2,"x":0.61,"y":0.52,"hp":5100,"maxHp":7000,"dead":false}]}'
```

## 4) Deploy SSH + domain `https://map.vthangios.xyz/`

Khuyến nghị dùng reverse proxy (Nginx/Caddy) trỏ về app Node:

- app chạy cổng nội bộ `3016`
- domain public `map.vthangios.xyz`
- bật hỗ trợ WebSocket upgrade (`/ws`)

Viewer link production:

- `https://map.vthangios.xyz/`
- `https://map.vthangios.xyz/webmap`
- `https://map.vthangios.xyz/webmap/<matchId>`

## 5) Cache bust thủ công (đổi tên file)

Project đang dùng chế độ **manual filename** cho asset:

- CSS: `/style.v13.css`
- JS: `/main.v13.js`

Khi sửa frontend và muốn chắc chắn trình duyệt không dùng cache cũ:

1. Đổi tên file CSS/JS trong thư mục `public/` (ví dụ `style.v14.css`, `main.v14.js`)
2. Sửa lại 2 đường dẫn tương ứng trong `public/index.html`
3. Restart server

<div align="center">

  <h1 align="center">game laucher</h1>

  <p align="center">
    <strong>game laucher là một nền tảng chơi game mã nguồn mở được tạo ra để trở thành công cụ duy nhất bạn cần để quản lý thư viện trò chơi của mình. game laucher được viết bằng Node.js (Electron, React, Typescript), Go và Rust.</strong>
  </p>

</div>

> ⚠️ **Fork của [hydralauncher/hydra](https://github.com/hydralauncher/hydra).** Đây là phiên bản cá nhân của dự án mã nguồn mở Hydra do Los Broxas phát triển, với các sửa đổi cho phù hợp với nhu cầu cá nhân (giao diện tiếng Việt, chuyển torrent RPC sang Go, điều chỉnh theme, và một số tinh chỉnh khác). Toàn bộ credit thuộc về các tác giả gốc — xem [Người đóng góp](#người-đóng-góp) và [LICENSE](LICENSE).

## Tính năng

### Quản lý game
- Duyệt catalogue Steam, tìm kiếm, lọc theo nhiều tiêu chí (Proton compatibility, năm phát hành, hệ điều hành)
- Thêm game tùy chỉnh từ đường dẫn executable bất kỳ
- Theo dõi thời gian chơi (playtime) và achievements real-time
- Backup / restore saves cục bộ qua Ludusavi
- Tạo Steam shortcut cho game đã cài

### Tải xuống
- Torrent client tích hợp (viết bằng **Go** — fork migration từ Python của upstream)
- Hỗ trợ **debrid services**: Real-Debrid, AllDebrid, Premiumize, TorBox
- Hỗ trợ **hosters**: Gofile, PixelDrain, Datanodes, Mediafire, Buzzheavier, FuckingFast, VikingFile, Rootz
- Tự động giải nén sau khi tải (Online-Fix, SteamRip và nhiều repack phổ biến khác)
- Hàng đợi download, pause / resume, theo dõi tiến độ và tốc độ real-time
- **Nhiều thư mục tải xuống** + chuyển toàn bộ game giữa các ổ đĩa khác nhau (cross-drive transfer)
- Notification khi download hoàn tất

### Cá nhân hóa
- **Theme editor** đầy đủ (mở trong cửa sổ riêng, hỗ trợ live preview và import CSS)
- 34 ngôn ngữ UI (bao gồm **tiếng Việt**)
- Thông báo cục bộ cho download và repack mới
- Collection / ghim game yêu thích

### Tích hợp hệ thống
- **Windows Defender exclusion** (thêm thư mục vào danh sách loại trừ qua UAC prompt)
- Proton / Wine / MangoHUD / GameMode support
- **Portable mode**: data lưu cạnh file thực thi — LevelDB, saves, downloads đi cùng `.exe`
- **Cloudflare DNS override** (tránh ISP chặn DNS)
- Chuyển toàn bộ game giữa các ổ đĩa với progress tracking

## Build từ Source Code

### Yêu cầu hệ thống

- Node.js
- Yarn
- Go toolchain

### Các lệnh cài đặt và Build

Cài đặt các gói phụ thuộc (Dependencies):

```bash
yarn install
```

Khởi chạy môi trường phát triển (Dev mode):

```bash
yarn dev
```

Build cho Windows:

```bash
yarn build:win
```

Build cho macOS:

```bash
yarn build:mac
```

Build cho Linux:

```bash
yarn build:linux
```

Build không đóng gói (Unpack mode):

```bash
yarn build:unpack
```

_Lưu ý: Các lệnh build tự động biên dịch phần Go RPC (`yarn build:go-rpc`) và web resources thông qua `electron-builder`._

## Người đóng góp

<a href="https://github.com/hydralauncher/hydra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=hydralauncher/hydra" />
</a>

## Giấy phép

game laucher được cấp phép theo [Giấy phép MIT](LICENSE).

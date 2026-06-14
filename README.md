<div align="center">

  <h1 align="center">game laucher</h1>

  <p align="center">
    <strong>game laucher là một nền tảng chơi game mã nguồn mở được tạo ra để trở thành công cụ duy nhất bạn cần để quản lý thư viện trò chơi của mình. game laucher được viết bằng Node.js (Electron, React, Typescript), Go và Rust.</strong>
  </p>

</div>

## Tính năng

- Thêm các trò chơi bạn sở hữu vào thư viện của mình
- Có một hồ sơ cá nhân đẹp mắt để hiển thị những gì bạn đang chơi cho bạn bè
- Lưu tiến trình trò chơi của bạn bằng lưu trữ cục bộ (local save)
- Mở khóa các thành tựu (achievements)
- Điều hướng qua một danh mục phong phú với thuật toán gợi ý mạnh mẽ
- Khám phá những trò chơi mới mà bạn chưa từng chơi trước đây

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

*Lưu ý: Các lệnh build tự động biên dịch phần Go RPC (`yarn build:go-rpc`) và web resources thông qua `electron-builder`.*

## Người đóng góp

<a href="https://github.com/hydralauncher/hydra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=hydralauncher/hydra" />
</a>

## Giấy phép

game laucher được cấp phép theo [Giấy phép MIT](LICENSE).
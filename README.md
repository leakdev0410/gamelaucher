<div align="center">

[<img src="https://raw.githubusercontent.com/hydralauncher/hydra/refs/heads/main/resources/icon.png" width="144"/>](https://help.hydralauncher.gg)

  <h1 align="center">GameLauncher</h1>

  <p align="center">
    <strong>GameLauncher là một nền tảng chơi game mã nguồn mở được tạo ra để trở thành công cụ duy nhất bạn cần để quản lý thư viện trò chơi của mình. GameLauncher được viết bằng Node.js (Electron, React, Typescript), Go và Rust.</strong>
  </p>

[![build](https://img.shields.io/github/actions/workflow/status/hydralauncher/hydra/build.yml)](https://github.com/hydralauncher/hydra/actions)
[![release](https://img.shields.io/github/package-json/v/hydralauncher/hydra)](https://github.com/hydralauncher/hydra/releases)
[![chocolatey](https://img.shields.io/chocolatey/v/hydralauncher.svg)](https://community.chocolatey.org/packages/hydralauncher)

![Trang chủ GameLauncher](./docs/screenshot.png)

</div>

## Tính năng

- Thêm các trò chơi bạn sở hữu vào thư viện của mình
- Có một hồ sơ cá nhân đẹp mắt để hiển thị những gì bạn đang chơi cho bạn bè
- Lưu tiến trình trò chơi của bạn bằng lưu trữ cục bộ (local save)
- Mở khóa các thành tựu (achievements)
- Điều hướng qua một danh mục phong phú với thuật toán gợi ý mạnh mẽ
- Khám phá những trò chơi mới mà bạn chưa từng chơi trước đây

## Biên dịch từ mã nguồn và đóng góp

Vui lòng tham khảo các trang Tài liệu của chúng tôi: [docs.hydralauncher.gg](https://docs.hydralauncher.gg/getting-started)

### Yêu cầu phát triển cục bộ

- Node.js + Yarn
- Go toolchain (dành cho torrent RPC — `yarn dev` chạy nó thông qua `go run`, `yarn build:go-rpc` dùng để biên dịch)

Để biên dịch toàn bộ ứng dụng cho Windows, bạn có thể chạy lệnh:

```bash
yarn build:win
```

Các tập lệnh đóng gói khác (`yarn build:mac`, `yarn build:linux`, `yarn build:unpack`) cũng đã tự động chạy `yarn build:go-rpc`.

## Người đóng góp

<a href="https://github.com/hydralauncher/hydra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=hydralauncher/hydra" />
</a>

## Giấy phép

GameLauncher được cấp phép theo [Giấy phép MIT](LICENSE).

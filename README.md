# dsh-geojson-map-viewer

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把会话中的 GeoJSON 汇聚成交互式 Leaflet 地图视图。

## 功能

- 扫描工作区中的 GeoJSON 文件，在内置地图视图中以下拉列表形式展示，点击即可在地图中查看
- 底图切换：OpenStreetMap 矢量底图与 ArcGIS 影像底图
- 点击查看要素属性，支持要素属性表展示
- 支持全部标准几何类型（Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon、GeometryCollection）
- 自动适配视野范围，最多支持 40 张地图卡片 / 会话，200 个会话
- 会话中消息文本、文件投递、工作区扫描三种来源的 GeoJSON 均自动检测，无需任何配置

![GeoJSON 地图视图](assets/screenshot-viewer.png)

## 安装

**从市场安装（推荐）**

在 DSH 插件市场搜索 `dsh-geojson-map-viewer`，点击安装即可。

**从源码安装**

克隆仓库后，在插件源码目录下执行：

```sh
git clone https://github.com/yuexushuang/dsh-geojson-map-viewer.git
cd dsh-geojson-map-viewer
dsh plugin add .
```

## 使用

1. 在会话中处理 GeoJSON 文件（生成、读取或展示）
2. 打开 **GeoJSON 地图查看器** 视图，从下拉列表中选择要查看的文件
3. 在查看器中切换底图、缩放平移，并查看要素属性表

## 依赖

需要一个带 Web 客户端的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 安装。地图服务需要联网。

## 许可证

MIT

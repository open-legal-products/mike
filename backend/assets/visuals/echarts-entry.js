import * as echarts from "echarts/core";
import {
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  ScatterChart,
  HeatmapChart,
  TreemapChart,
  SankeyChart,
  FunnelChart,
  RadarChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  AriaComponent,
  GraphicComponent,
  DatasetComponent,
  RadarComponent,
  MarkLineComponent,
} from "echarts/components";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  ScatterChart,
  HeatmapChart,
  TreemapChart,
  SankeyChart,
  FunnelChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  AriaComponent,
  GraphicComponent,
  DatasetComponent,
  RadarComponent,
  MarkLineComponent,
  LabelLayout,
  SVGRenderer,
]);

window.echarts = echarts;

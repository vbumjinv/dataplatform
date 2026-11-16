export type PykrxDataset = {
  id: string;
  item_name: string;
  category_name: string;
  description: string;
};

// pykrx 가 data.krx.co.kr 화면에서 읽는 KOSPI 시세.
// kospi 는 코스피 지수(1001) 한 줄, kospi_series 는 코스피 전 지수.
export const PYKRX_DATASETS: PykrxDataset[] = [
  {
    id: "kospi",
    item_name: "KOSPI",
    category_name: "지수",
    description: "코스피 지수(1001) 일별 시가·고가·저가·종가·거래량",
  },
  {
    id: "kospi_series",
    item_name: "KOSPI 시리즈",
    category_name: "지수",
    description: "코스피 전 지수 일별 시세",
  },
];

export const findPykrxDataset = (id: string | null | undefined) =>
  PYKRX_DATASETS.find((item) => item.id === (id ?? "").trim()) ?? null;

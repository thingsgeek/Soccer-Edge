export interface KalshiSeries {
  ticker: string;
  title: string;
  tags?: string[] | null;
  contract_url?: string;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  title: string;
  yes_sub_title?: string;
  floor_strike?: number | null;
  strike_type?: string | null;
  custom_strike?: Record<string, string> | null;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  status: string;
  /** Settlement result once finalized: "yes" or "no". */
  result?: string;
  occurrence_datetime?: string;
  expected_expiration_time?: string;
  close_time?: string;
  volume_24h_fp?: string;
  tick_size?: number;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  markets?: KalshiMarket[];
}

/** Parse a fixed-point dollar string to a 0-1 number; NaN if missing. */
export function dollars(v: string | undefined | null): number {
  if (v === undefined || v === null || v === '') return NaN;
  return parseFloat(v);
}

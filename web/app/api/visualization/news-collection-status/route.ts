import { NextResponse } from "next/server";
import { canUseDb, connectWithTimeout, createDbClientFromRequest } from "../_lib/db";

export const runtime = "nodejs";

type CountRow = {
  day: string;
  minute: number;
  total: number;
  ok: number;
  low_quality: number;
  failed: number;
  pending: number;
};

const emptySummary = {
  total: 0,
  ok: 0,
  lowQuality: 0,
  failed: 0,
  pending: 0,
};

const buildDateList = (today: string) => {
  const [year, month, day] = today.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
};

const shiftDate = (iso: string, days: number) => {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const expandCronField = (field: string, min: number, max: number) => {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const token = part.trim();
    const stepped = token.match(/^(?:(\*)|(\d+)(?:-(\d+))?)\/(\d+)$/);
    if (stepped) {
      const start = stepped[1] ? min : Number(stepped[2]);
      const end = stepped[3] ? Number(stepped[3]) : max;
      const step = Number(stepped[4]);
      if (!step) return null;
      for (let value = start; value <= end; value += step) values.add(value);
      continue;
    }
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let value = Number(range[1]); value <= Number(range[2]); value += 1) values.add(value);
      continue;
    }
    if (token === "*") {
      for (let value = min; value <= max; value += 1) values.add(value);
      continue;
    }
    if (/^\d+$/.test(token)) {
      values.add(Number(token));
      continue;
    }
    return null;
  }
  return [...values].filter((value) => value >= min && value <= max).sort((left, right) => left - right);
};

const scheduleTimesFromCron = (cronExpr: string) => {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length < 5) return [];
  const minutes = expandCronField(fields[0], 0, 59);
  const hours = expandCronField(fields[1], 0, 23);
  if (!minutes || !hours || minutes.length === 0 || hours.length === 0) return [];
  const times = hours.flatMap((hour) =>
    minutes.map((minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`),
  );
  const unique = [...new Set(times)].sort();
  return unique.length <= 24 ? unique : [];
};

const addCount = (
  target: { total: number; ok: number; lowQuality: number; failed: number; pending: number },
  row: CountRow,
) => {
  target.total += Number(row.total ?? 0);
  target.ok += Number(row.ok ?? 0);
  target.lowQuality += Number(row.low_quality ?? 0);
  target.failed += Number(row.failed ?? 0);
  target.pending += Number(row.pending ?? 0);
};

export async function GET(request: Request) {
  if (!canUseDb()) {
    return NextResponse.json({ ok: false, error: "DB 환경변수 설정이 필요합니다." }, { status: 400 });
  }
  const client = await createDbClientFromRequest(request);
  if (!client) {
    return NextResponse.json({ ok: false, error: "DB 접속 URL 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    await connectWithTimeout(client);
    const tableCheck = await client.query<{ article: boolean; job: boolean; source: boolean }>(
      `select to_regclass('dp.news_stock_article') is not null as article,
              to_regclass('dp.news_stock_collect_job') is not null as job,
              to_regclass('dp.news_stock_source') is not null as source`,
    );
    const clockResult = await client.query<{ today: string; now_time: string }>(
      `select to_char((now() at time zone 'Asia/Seoul')::date, 'YYYY-MM-DD') as today,
              to_char(now() at time zone 'Asia/Seoul', 'HH24:MI') as now_time`,
    );
    const today = String(clockResult.rows[0]?.today ?? new Date().toISOString().slice(0, 10));
    const nowTime = String(clockResult.rows[0]?.now_time ?? "00:00");
    const dates = buildDateList(today);

    let times: string[] = [];
    if (tableCheck.rows[0]?.source) {
      const sourceResult = await client.query<{
        schedule_enabled: boolean;
        schedule_type: string;
        schedule_cron_expr: string;
      }>(
        `select schedule_enabled, schedule_type, schedule_cron_expr
         from dp.news_stock_source
         where source_key = 'naver-pay'`,
      );
      const source = sourceResult.rows[0];
      if (source?.schedule_enabled && source.schedule_type !== "interval") {
        times = scheduleTimesFromCron(String(source.schedule_cron_expr ?? ""));
      }
    }

    const emptyDaily = dates.map((crawlDate) => ({
      crawlDate,
      ...emptySummary,
      lastPublished: null as string | null,
    }));
    const emptySlots = dates.flatMap((crawlDate) =>
      times.map((time) => ({
        crawlDate,
        time,
        ...emptySummary,
        reached: crawlDate < today || (crawlDate === today && time <= nowTime),
      })),
    );

    if (!tableCheck.rows[0]?.article) {
      return NextResponse.json({
        ok: true,
        today,
        summary: emptySummary,
        job: null,
        scheduleTimes: times,
        daily: emptyDaily,
        slots: emptySlots,
      });
    }

    const countResult = await client.query<CountRow>(
      `
        select to_char((body_fetched_at at time zone 'Asia/Seoul')::date, 'YYYY-MM-DD') as day,
               (extract(hour from body_fetched_at at time zone 'Asia/Seoul')::int * 60
                 + extract(minute from body_fetched_at at time zone 'Asia/Seoul')::int) as minute,
               count(*)::int as total,
               count(*) filter (where body_status = 'ok')::int as ok,
               count(*) filter (where body_status = 'low_quality')::int as low_quality,
               count(*) filter (where body_status = 'failed')::int as failed,
               count(*) filter (where body_status = 'pending')::int as pending
        from dp.news_stock_article
        where body_fetched_at >= (((now() at time zone 'Asia/Seoul')::date - 7)::timestamp at time zone 'Asia/Seoul')
          and body_fetched_at < (((now() at time zone 'Asia/Seoul')::date + 1)::timestamp at time zone 'Asia/Seoul')
        group by 1, 2
      `,
    );

    const slotMinutes = times.map((time) => {
      const [hour, minute] = time.split(":").map(Number);
      return hour * 60 + minute;
    });
    const buckets = new Map<string, { total: number; ok: number; lowQuality: number; failed: number; pending: number; lastMinute: number }>();
    const touch = (key: string) => {
      const current = buckets.get(key);
      if (current) return current;
      const created = { total: 0, ok: 0, lowQuality: 0, failed: 0, pending: 0, lastMinute: -1 };
      buckets.set(key, created);
      return created;
    };

    countResult.rows.forEach((row) => {
      const minute = Number(row.minute ?? 0);
      let crawlDate = String(row.day);
      let slotTime = "";
      if (slotMinutes.length > 0) {
        let index = -1;
        for (let cursor = 0; cursor < slotMinutes.length; cursor += 1) {
          if (slotMinutes[cursor] <= minute) index = cursor;
        }
        if (index < 0) {
          crawlDate = shiftDate(crawlDate, -1);
          index = slotMinutes.length - 1;
        }
        slotTime = times[index];
      }
      if (!dates.includes(crawlDate)) return;
      const daily = touch(crawlDate);
      addCount(daily, row);
      daily.lastMinute = Math.max(daily.lastMinute, minute);
      if (slotTime) addCount(touch(`${crawlDate}|${slotTime}`), row);
    });

    const formatMinute = (minute: number) => {
      if (minute < 0) return null;
      return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    };
    const daily = dates.map((crawlDate) => {
      const bucket = buckets.get(crawlDate);
      return {
        crawlDate,
        total: bucket?.total ?? 0,
        ok: bucket?.ok ?? 0,
        lowQuality: bucket?.lowQuality ?? 0,
        failed: bucket?.failed ?? 0,
        pending: bucket?.pending ?? 0,
        lastPublished: formatMinute(bucket?.lastMinute ?? -1),
      };
    });
    const slots = dates.flatMap((crawlDate) =>
      times.map((time) => {
        const bucket = buckets.get(`${crawlDate}|${time}`);
        return {
          crawlDate,
          time,
          total: bucket?.total ?? 0,
          ok: bucket?.ok ?? 0,
          lowQuality: bucket?.lowQuality ?? 0,
          failed: bucket?.failed ?? 0,
          pending: bucket?.pending ?? 0,
          reached: crawlDate < today || (crawlDate === today && time <= nowTime),
        };
      }),
    );
    const todayRow = daily.find((row) => row.crawlDate === today);

    let job: {
      status: string;
      startDate: string;
      endDate: string;
      message: string;
      updatedAt: string | null;
    } | null = null;
    if (tableCheck.rows[0]?.job) {
      const jobResult = await client.query<{
        status: string;
        start_date: string;
        end_date: string;
        message: string;
        updated_at: Date | null;
      }>(
        `select status, start_date::text, end_date::text, message, updated_at
         from dp.news_stock_collect_job
         where id = 1`,
      );
      const row = jobResult.rows[0];
      if (row) {
        job = {
          status: String(row.status),
          startDate: String(row.start_date),
          endDate: String(row.end_date),
          message: String(row.message ?? ""),
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        };
      }
    }

    return NextResponse.json({
      ok: true,
      today,
      summary: todayRow
        ? {
            total: todayRow.total,
            ok: todayRow.ok,
            lowQuality: todayRow.lowQuality,
            failed: todayRow.failed,
            pending: todayRow.pending,
          }
        : emptySummary,
      job,
      scheduleTimes: times,
      daily,
      slots,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "뉴스 수집 현황을 불러오지 못했습니다.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

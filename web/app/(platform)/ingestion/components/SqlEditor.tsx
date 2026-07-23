"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

// 줄 머리(들여쓰기 뒤)의 '-- ' 주석 표식. 주석 토글(Ctrl+/)에 사용.
const COMMENT_RE = /^(\s*)-- ?/;

// HTML 특수문자 escape (하이라이트 백드롭에 그대로 주입하므로 필수)
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// '--' 부터 줄 끝까지를 SQL 한 줄 주석으로 보고 초록색으로 칠한다.
// (문자열 리터럴 안의 '--' 까지 구분하진 않는 단순 규칙 — 편집 가독성 용도)
const highlightSql = (sql: string): string =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      if (idx === -1) return escapeHtml(line);
      return (
        escapeHtml(line.slice(0, idx)) +
        `<span class="text-emerald-600">${escapeHtml(line.slice(idx))}</span>`
      );
    })
    .join("\n");

// 투명한 textarea 를 동일 서식의 하이라이트 백드롭 위에 겹쳐, 주석 줄을 초록색으로 보여주는 에디터.
// textarea 와 backdrop 의 글꼴·줄높이·패딩·테두리·줄바꿈 규칙이 100% 일치해야 글자가 어긋나지 않는다.
export default function SqlEditor({
  value,
  onChange,
  rows = 12,
  spellCheck = false,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  spellCheck?: boolean;
  placeholder?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  // Ctrl+/ 토글 후 복원할 선택 영역. value(props) 갱신→리렌더 후 effect 에서 적용한다.
  const pendingSel = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (pendingSel.current && taRef.current) {
      const [s, e] = pendingSel.current;
      taRef.current.setSelectionRange(s, e);
      pendingSel.current = null;
    }
  });

  // 스크롤 동기화: textarea 를 스크롤하면 백드롭도 같은 위치로 이동
  const syncScroll = () => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  // Ctrl+/ (맥: Cmd+/) → 현재 줄(또는 선택한 모든 줄) 주석 토글.
  // 선택 줄이 모두 주석이면 해제, 하나라도 비주석이면 전부 주석.
  const toggleComment = () => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    // 선택을 줄 단위(시작 줄 머리 ~ 끝 줄 끝)로 확장
    const blockStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    let blockEnd = value.indexOf("\n", selectionEnd);
    if (blockEnd === -1) blockEnd = value.length;

    const lines = value.slice(blockStart, blockEnd).split("\n");
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => COMMENT_RE.test(l));

    const newLines = allCommented
      ? lines.map((l) => l.replace(COMMENT_RE, "$1")) // 주석 해제
      : lines.map((l) => (l.trim().length === 0 ? l : l.replace(/^(\s*)/, "$1-- "))); // 주석

    const newBlock = newLines.join("\n");
    if (newBlock === value.slice(blockStart, blockEnd)) return; // 변화 없으면 무시

    // 토글한 줄 전체를 다시 선택 상태로 유지
    pendingSel.current = [blockStart, blockStart + newBlock.length];
    // 네이티브 실행취소(Ctrl+Z) 스택에 남도록 execCommand 로 교체한다.
    // (onChange 로 값을 통째로 바꾸면 undo 이력이 끊긴다)
    ta.setSelectionRange(blockStart, blockEnd);
    const ok = document.execCommand("insertText", false, newBlock);
    if (!ok) {
      // execCommand 미지원 폴백 (이 경우 해당 토글은 Ctrl+Z 로 되돌릴 수 없음)
      onChange(value.slice(0, blockStart) + newBlock + value.slice(blockEnd));
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "/") {
      e.preventDefault();
      toggleComment();
    }
  };

  // textarea·backdrop 공통 서식 (서식 불일치 시 글자가 어긋나므로 반드시 동일하게 유지)
  const shared =
    "m-0 w-full rounded-xl border px-3 py-2 font-mono text-[12px] leading-5 " +
    "whitespace-pre-wrap break-words box-border";

  return (
    <div className="relative">
      <pre
        ref={preRef}
        aria-hidden
        className={`${shared} pointer-events-none absolute inset-0 overflow-auto border-transparent text-slate-800`}
        // 끝의 개행은 textarea 가 마지막 빈 줄을 그리는 동작과 맞추기 위함
        dangerouslySetInnerHTML={{ __html: highlightSql(value) + "\n" }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        spellCheck={spellCheck}
        rows={rows}
        placeholder={placeholder}
        // 글자는 투명, 커서만 보이게 → 실제 글자는 뒤의 백드롭이 그린다
        className={`${shared} relative resize-y border-slate-200 bg-transparent text-transparent caret-slate-800 focus:border-slate-400 focus:outline-none`}
      />
    </div>
  );
}

"use client";
import clsx from "clsx";
import {fmtPrice } from "@/lib/client";

export interface Cell {
  state: "none" | "removed" | "oos" | "no_price" | "price";
  listingId?: string;
  price?: number | null;
  currency?: string | null;
  previousPrice?: number | null;
  direction?: "up" | "down" | null;
  url?: string;
  more?: number;
}

/** FR-GRID-03 cell states. OOS is greyed and not clickable (D-19). */
export function PriceCell({ cell, onMore }: { cell: Cell; onMore: () => void }) {
  if (cell.state === "none") return <span className="text-gray-300">—</span>;
  if (cell.state === "removed") return <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">Removed</span>;

  const arrow =
    cell.direction === "up" ? (
      <span aria-label={`Price increased from ${fmtPrice(cell.previousPrice, cell.currency)}`} className="text-red-600">▲</span>
    ) : cell.direction === "down" ? (
      <span aria-label={`Price decreased from ${fmtPrice(cell.previousPrice, cell.currency)}`} className="text-green-600">▼</span>
    ) : null;
  const old = cell.direction ? <span className="text-xs text-gray-400 line-through">{fmtPrice(cell.previousPrice, cell.currency)}</span> : null;
  const more = (cell.more ?? 0) > 0 ? (
    <button type="button" onClick={onMore} className="text-xs text-indigo-600 hover:underline">+{cell.more} more</button>
  ) : null;

  let main: React.ReactNode;
  if (cell.state === "oos") {
    main = (
      <span aria-disabled="true" title="Out of stock" className={clsx("cursor-not-allowed text-gray-400")}>
        <span className="font-medium">{fmtPrice(cell.price, cell.currency)}</span><span className="sr-only"> (out of stock)</span>
      </span>
    );
  } else if (cell.state === "no_price") {
    main = <a href={cell.url} target="_blank" rel="noreferrer" className="text-xs italic text-gray-500 hover:underline">Price unavailable</a>;
  } else {
    main = (
      <a href={cell.url} target="_blank" rel="noreferrer" className="font-medium text-gray-900 hover:text-indigo-700 hover:underline">
        {fmtPrice(cell.price, cell.currency)}
      </a>
    );
  }
  return (
    <div className="flex flex-col items-center leading-tight">
      <div className="flex items-center justify-center gap-1">{main}{arrow}</div>
      {(old || more) && <div className="flex items-center justify-center gap-2">{old}{more}</div>}
    </div>
  );
}

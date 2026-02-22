"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ItemSnapshot = {
  id: string;
  productName: string;
  priceCents: number | null;
  inStock: boolean | null;
  stockState?: "IN_STOCK" | "OUT_OF_STOCK" | "PARTIAL" | "UNKNOWN" | null;
  checkedAt: string;
};

type CheckRun = {
  id: string;
  status: "SUCCESS" | "FAILED" | "NEEDS_REVIEW";
  startedAt: string;
  errorCode?: string | null;
};

type TrackedItem = {
  id: string;
  url: string;
  siteHost: string;
  createdAt: string;
  snapshots: ItemSnapshot[];
  checkRuns: CheckRun[];
  lastPriceChange?: {
    fromPriceCents: number;
    toPriceCents: number;
    changedAt: string;
  } | null;
};

type UiStatus = {
  tone: "info" | "success" | "error";
  message: string;
};

export default function Home() {
  const [items, setItems] = useState<TrackedItem[]>([]);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [discordBusy, setDiscordBusy] = useState(false);

  const totalTracked = useMemo(() => items.length, [items]);
  const changedCount = useMemo(() => items.filter((item) => Boolean(item.lastPriceChange)).length, [items]);
  const outOfStockCount = useMemo(() => items.filter((item) => item.snapshots[0]?.inStock === false).length, [items]);
  const reviewCount = useMemo(
    () => items.filter((item) => item.checkRuns[0]?.status === "NEEDS_REVIEW" || item.checkRuns[0]?.status === "FAILED").length,
    [items],
  );

  async function loadItems() {
    try {
      const response = await fetch("/api/items", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load items");
      }
      setItems(payload.items ?? []);
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to load items",
      });
    }
  }

  useEffect(() => {
    void loadItems();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    setAdding(true);

    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to add item");
      }

      setUrl("");
      if (payload.created && payload.initialCheck) {
        const stockSuffix =
          payload.initialCheck.stockState === "PARTIAL"
            ? " Marked as partial stock."
            : payload.initialCheck.inStock === false
            ? " Marked as out of stock."
            : payload.initialCheck.inStock === true
              ? " Marked as in stock."
              : "";
        setStatus({
          tone: payload.initialCheck.status === "SUCCESS" ? "success" : "info",
          message: `Added item ${payload.itemId}. Initial check: ${payload.initialCheck.status}.${stockSuffix}`,
        });
      } else {
        setStatus({ tone: "info", message: `Item already tracked: ${payload.itemId}` });
      }

      await loadItems();
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Failed to add item",
      });
    } finally {
      setAdding(false);
    }
  }

  async function runCheck(id: string) {
    setBusyItemId(id);
    setStatus({ tone: "info", message: "Running check..." });

    try {
      const response = await fetch(`/api/items/${id}/check`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Check failed");
      }

      setStatus({
        tone: payload.status === "SUCCESS" ? "success" : "info",
        message: `Check status: ${payload.status}${payload.changed ? " (price changed)" : ""}${
          payload.stockState === "PARTIAL"
            ? " (partial stock)"
            : payload.inStock === false
              ? " (out of stock)"
              : payload.inStock === true
                ? " (in stock)"
                : ""
        }`,
      });
      await loadItems();
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Check failed",
      });
    } finally {
      setBusyItemId(null);
    }
  }

  async function deleteItem(id: string) {
    setBusyItemId(id);

    try {
      const response = await fetch(`/api/items/${id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Delete failed");
      }

      setStatus({ tone: "success", message: "Item deleted" });
      await loadItems();
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Delete failed",
      });
    } finally {
      setBusyItemId(null);
    }
  }

  async function sendDiscordTest() {
    setDiscordBusy(true);

    try {
      const response = await fetch("/api/discord/test", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Discord test failed");
      }

      setStatus({ tone: "success", message: `Discord test sent (status ${payload.status})` });
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Discord test failed",
      });
    } finally {
      setDiscordBusy(false);
    }
  }

  function formatPrice(priceCents: number | null | undefined): string {
    if (typeof priceCents !== "number") {
      return "n/a";
    }
    const amount = new Intl.NumberFormat("en-CA", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }).format(priceCents / 100);
    return `$${amount}`;
  }

  function formatDate(input: string): string {
    return new Date(input).toLocaleString("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatChange(change: TrackedItem["lastPriceChange"]) {
    if (!change) {
      return { primary: "No change", secondary: "-", tone: "flat" as const };
    }

    const deltaCents = change.toPriceCents - change.fromPriceCents;
    const absDelta = Math.abs(deltaCents);
    const from = change.fromPriceCents;
    const percent = from > 0 ? (absDelta / from) * 100 : null;
    const direction = deltaCents > 0 ? "up" : deltaCents < 0 ? "down" : "flat";
    const sign = deltaCents > 0 ? "+" : deltaCents < 0 ? "-" : "";
    const percentText = percent === null ? "" : ` (${sign}${percent.toFixed(2)}%)`;

    return {
      primary: `${formatPrice(change.fromPriceCents)} -> ${formatPrice(change.toPriceCents)}`,
      secondary: `${sign}${formatPrice(absDelta)}${percentText}`,
      tone: direction as "up" | "down" | "flat",
    };
  }

  function runStatusClass(run: CheckRun | undefined): string {
    if (!run) {
      return "status-chip neutral";
    }
    if (run.status === "SUCCESS") {
      return "status-chip success";
    }
    if (run.status === "NEEDS_REVIEW") {
      return "status-chip warn";
    }
    return "status-chip error";
  }

  function stockStatusLabel(snapshot: ItemSnapshot | undefined): string {
    if (!snapshot) {
      return "Unknown";
    }
    if (snapshot.stockState === "PARTIAL") {
      return "Partial stock";
    }
    if (snapshot.inStock === true) {
      return "In stock";
    }
    if (snapshot.inStock === false) {
      return "Out of stock";
    }
    return "Unknown";
  }

  function stockStatusClass(snapshot: ItemSnapshot | undefined): string {
    if (!snapshot || snapshot.inStock === null) {
      return "stock-chip neutral";
    }
    if (snapshot.stockState === "PARTIAL") {
      return "stock-chip partial";
    }
    if (snapshot.inStock === true) {
      return "stock-chip in";
    }
    return "stock-chip out";
  }

  function shouldTreatSnapshotAsStale(snapshot: ItemSnapshot | undefined, run: CheckRun | undefined): boolean {
    if (!run || run.status === "SUCCESS") {
      return false;
    }
    if (!snapshot) {
      return true;
    }
    const runStartedAt = new Date(run.startedAt).getTime();
    const snapshotCheckedAt = new Date(snapshot.checkedAt).getTime();
    return Number.isFinite(runStartedAt) && Number.isFinite(snapshotCheckedAt) ? runStartedAt >= snapshotCheckedAt : true;
  }

  return (
    <main className="dashboard">
      <header className="hero">
        <div>
          <h1>Price Tracker</h1>
          <p>Compact view of current prices, recent deltas, and check health.</p>
        </div>
        <div className="stats-grid">
          <div className="stat-tile">
            <span>Tracked</span>
            <strong>{totalTracked}</strong>
          </div>
          <div className="stat-tile">
            <span>Changed</span>
            <strong>{changedCount}</strong>
          </div>
          <div className="stat-tile">
            <span>Out of Stock</span>
            <strong>{outOfStockCount}</strong>
          </div>
          <div className="stat-tile">
            <span>Needs Review</span>
            <strong>{reviewCount}</strong>
          </div>
        </div>
      </header>

      <section className="panel control-panel">
        <form onSubmit={onSubmit} className="control-form">
          <input
            required
            type="url"
            placeholder="https://example.com/product"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button disabled={adding} type="submit">
            {adding ? "Adding..." : "Add URL"}
          </button>
          <button className="secondary" disabled={discordBusy} type="button" onClick={sendDiscordTest}>
            {discordBusy ? "Sending..." : "Discord Test"}
          </button>
        </form>
        {status ? <p className={`inline-status ${status.tone}`}>{status.message}</p> : null}
      </section>

      <section className="panel list-panel">
        <div className="list-head">
          <span>Product</span>
          <span>Current</span>
          <span>Last Change</span>
          <span>Stock</span>
          <span>Last Check</span>
          <span>Actions</span>
        </div>

        <div className="item-list">
          {items.map((item) => {
            const snapshot = item.snapshots[0];
            const run = item.checkRuns[0];
            const isBusy = busyItemId === item.id;
            const change = formatChange(item.lastPriceChange);
            const staleSnapshot = shouldTreatSnapshotAsStale(snapshot, run);
            const displaySnapshot = staleSnapshot ? undefined : snapshot;

            return (
              <article key={item.id} className="item-row">
                <div className="item-product">
                  <div className="item-title-row">
                    <h3>{snapshot?.productName ?? item.siteHost}</h3>
                    {run && run.status !== "SUCCESS" ? (
                      <span className={runStatusClass(run)}>{run.status === "NEEDS_REVIEW" ? "Review" : "Failed"}</span>
                    ) : null}
                  </div>
                  <div className="item-meta-row">
                    <a className="item-url" href={item.url} rel="noreferrer" target="_blank">
                      {item.siteHost}
                    </a>
                  </div>
                </div>

                <div className="metric-cell" data-label="Current">
                  <span className="metric-primary">
                    {displaySnapshot ? formatPrice(displaySnapshot.priceCents) : staleSnapshot ? "Review needed" : "-"}
                  </span>
                  {staleSnapshot && snapshot ? <span className="metric-secondary flat">{`Last good ${formatPrice(snapshot.priceCents)}`}</span> : null}
                </div>

                <div className="metric-cell change-cell" data-label="Last Change">
                  <span className="metric-primary">{change.primary}</span>
                  <span className={`metric-secondary ${change.tone}`}>{change.secondary}</span>
                </div>

                <div className="metric-cell" data-label="Stock">
                  <span className={stockStatusClass(displaySnapshot)}>{staleSnapshot ? "Unknown" : stockStatusLabel(displaySnapshot)}</span>
                </div>

                <div className="metric-cell subtle" data-label="Last Check">
                  {run ? `${run.status} · ${formatDate(run.startedAt)}` : "Never"}
                </div>

                <div className="action-cell">
                  <button className="tertiary" disabled={isBusy} onClick={() => runCheck(item.id)}>
                    {isBusy ? "Working..." : "Check"}
                  </button>
                  <button className="danger" disabled={isBusy} onClick={() => deleteItem(item.id)}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}

          {items.length === 0 ? <p className="empty">No items tracked yet.</p> : null}
        </div>
      </section>
    </main>
  );
}

"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ItemSnapshot = {
  id: string;
  productName: string;
  priceCents: number;
  currency: string;
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
    currency: string;
    changedAt: string;
  } | null;
};

export default function Home() {
  const [items, setItems] = useState<TrackedItem[]>([]);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const totalTracked = useMemo(() => items.length, [items]);

  async function loadItems() {
    const response = await fetch("/api/items", { cache: "no-store" });
    const payload = await response.json();
    setItems(payload.items ?? []);
  }

  useEffect(() => {
    void loadItems();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    setLoading(true);

    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to add item");
      }

      setUrl("");
      if (payload.created && payload.initialCheck) {
        setStatus(`Added item ${payload.itemId}. Initial check: ${payload.initialCheck.status}.`);
      } else {
        setStatus(`Item already tracked: ${payload.itemId}`);
      }
      await loadItems();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to add item");
    } finally {
      setLoading(false);
    }
  }

  async function runCheck(id: string) {
    setStatus("Running check...");
    const response = await fetch(`/api/items/${id}/check`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error ?? "Check failed");
      return;
    }

    setStatus(`Check status: ${payload.status}${payload.changed ? " (price changed)" : ""}`);
    await loadItems();
  }

  async function deleteItem(id: string) {
    const response = await fetch(`/api/items/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json();
      setStatus(payload.error ?? "Delete failed");
      return;
    }

    setStatus("Item deleted");
    await loadItems();
  }

  async function sendDiscordTest() {
    const response = await fetch("/api/discord/test", { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.error ?? "Discord test failed");
      return;
    }
    setStatus(`Discord test sent (status ${payload.status})`);
  }

  function formatPrice(priceCents: number, currency: string): string {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
    }).format(priceCents / 100);
  }

  return (
    <main className="container">
      <header className="hero">
        <h1>Price Tracker</h1>
        <p>Track product page prices and get Discord alerts when they change.</p>
        <p className="meta">Tracked items: {totalTracked}</p>
      </header>

      <section className="card">
        <h2>Add Product URL</h2>
        <form onSubmit={onSubmit} className="grid-form">
          <label>
            URL
            <input
              required
              type="url"
              placeholder="https://example.com/product"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>

          <button disabled={loading} type="submit">
            {loading ? "Adding..." : "Add"}
          </button>
        </form>
        <button className="secondary" onClick={sendDiscordTest}>
          Send Discord Test
        </button>
        {status ? <p className="status">{status}</p> : null}
      </section>

      <section className="card">
        <h2>Tracked Items</h2>
        <div className="items">
          {items.map((item) => {
            const snapshot = item.snapshots[0];
            const run = item.checkRuns[0];
            return (
              <article key={item.id} className="item">
                <div>
                  <h3>{snapshot?.productName ?? item.siteHost}</h3>
                  <p className="url">{item.url}</p>
                  <p>
                    Current Price: {snapshot ? formatPrice(snapshot.priceCents, snapshot.currency) : "No data"}
                  </p>
                  <p>
                    Last Price Change:{" "}
                    {item.lastPriceChange
                      ? `${formatPrice(item.lastPriceChange.fromPriceCents, item.lastPriceChange.currency)} -> ${formatPrice(item.lastPriceChange.toPriceCents, item.lastPriceChange.currency)} at ${new Date(item.lastPriceChange.changedAt).toLocaleString()}`
                      : "No price change yet"}
                  </p>
                  <p>Last Check: {run ? `${run.status} at ${new Date(run.startedAt).toLocaleString()}` : "Never"}</p>
                </div>
                <div className="actions">
                  <button onClick={() => runCheck(item.id)}>Check Now</button>
                  <button className="danger" onClick={() => deleteItem(item.id)}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}

          {items.length === 0 ? <p>No items tracked yet.</p> : null}
        </div>
      </section>
    </main>
  );
}

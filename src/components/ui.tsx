// 服务端通用 UI 组件
import Link from "next/link";
import type { ReactNode } from "react";
import { getSession } from "@/lib/auth";
import { ROLE_LABELS, ROLE_HOME } from "@/lib/labels";
import { LogoutButton } from "./client";

export async function AppShell(props: { title: string; children: ReactNode }) {
  const user = await getSession();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">月</span>
          <div>
            <div className="brand-name">悦安月子中心</div>
            <div className="brand-sub">产妇护理计划与家属探访平台</div>
          </div>
        </div>
        {user && (
          <div className="user-box">
            <span className="user-name">{user.name}</span>
            <span className="badge blue">{ROLE_LABELS[user.role] || user.role}</span>
            <Link className="btn default small" href={ROLE_HOME[user.role] || "/"}>工作台</Link>
            <LogoutButton />
          </div>
        )}
      </header>
      <main className="main">
        <h1 className="page-title">{props.title}</h1>
        {props.children}
      </main>
    </div>
  );
}

export function Section(props: { title: string; extra?: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <section className={`card ${props.tone || ""}`}>
      <div className="card-head">
        <h2>{props.title}</h2>
        {props.extra}
      </div>
      <div className="card-body">{props.children}</div>
    </section>
  );
}

export function Badge(props: { text: string; cls?: string }) {
  return <span className={props.cls || "badge gray"}>{props.text}</span>;
}

export function DataTable(props: { cols: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!props.rows.length) {
    return <div className="empty">{props.empty || "暂无数据"}</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{props.cols.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {props.rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KV(props: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {props.items.map(([k, v], i) => (
        <div key={i} className="kv-item">
          <dt>{k}</dt>
          <dd>{v ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

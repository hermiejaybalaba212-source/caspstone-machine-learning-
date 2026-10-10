"use client";
import toast from "react-hot-toast";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/browser";
import { formatDateTime, downloadCsv } from "@/lib/utils";
import JSZip from "jszip";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

interface StudentAccount {
  student_id: number;
  student_number?: string;
  given_name?: string;
  last_name?: string;
  middle_name?: string;
  year_level?: string;
}

interface SupportDocument {
  document_id: number;
  application_id: number;
  document_type: string;
  file_path: string;
  upload_date?: string;
  scholarship_applications?: { student_accounts?: StudentAccount };
}

interface AcademicRecord {
  record_id: number;
  student_id: number;
  applicant_type: string;
  shs_gwa?: string;
  college_gpa?: string;
  proof_image_path?: string;
  created_at?: string;
  student_accounts?: StudentAccount;
}

interface ChedForm {
  ched_form_id: number;
  application_id: number;
  student_id?: string;
  last_name?: string;
  given_name?: string;
  middle_name?: string;
  year_level?: string;
  annual_income_family?: number;
  income_tax_return?: string;
  contact_number?: string;
  email_address?: string;
  father_name?: string;
  mother_name?: string;
  created_at?: string;
  scholarship_applications?: {
    scholarship_programs?: { scholarship_name: string };
    student_accounts?: StudentAccount;
  };
}

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg)$/i;
function isImagePath(path?: string) {
  return !!path && IMG_RE.test(path.split(/[?#]/)[0]);
}

function fullName(s?: StudentAccount | { given_name?: string; last_name?: string; middle_name?: string }) {
  if (!s) return "Student";
  const first = [s.given_name, "middle_name" in s ? s.middle_name : undefined].filter(Boolean).join(" ");
  const n = `${s.last_name || ""}, ${first}`.replace(/^, |, $/g, "").trim();
  return n || "Student";
}

function safeFile(name: string) {
  return name.replace(/[^\w.]+/g, "_");
}

type Kind = "support" | "academic" | "itr";

const KIND_META: Record<Kind, { label: string; cls: string }> = {
  itr: { label: "ITR", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  academic: { label: "Academic Record", cls: "border-blue-200 bg-blue-50 text-blue-700" },
  support: { label: "Support Document", cls: "border-[#7B1113]/25 bg-[#7B1113]/5 text-[#7B1113]" },
};
const KIND_ORDER: Record<Kind, number> = { itr: 0, academic: 1, support: 2 };

type DocRow = {
  key: string;
  kind: Kind;
  studentNumber: string;
  name: string;
  year: string;
  details: string;
  uploaded?: string;
  url?: string;
  bucket: string;
  path: string;
  deleteId: number;
  fileLabel: string;
};

type PreviewItem = { url: string; name: string; bucket: string; path: string };

export default function AdminDocumentsPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [students, setStudents] = useState<StudentAccount[]>([]);
  const [docs, setDocs] = useState<SupportDocument[]>([]);
  const [acads, setAcads] = useState<AcademicRecord[]>([]);
  const [chedForms, setChedForms] = useState<ChedForm[]>([]);
  const [selectedStudent, setSelectedStudent] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | Kind>("all");
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlProgress, setDlProgress] = useState({ done: 0, total: 0 });
  const [delBusyKey, setDelBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function startFetching() {
      const sb = getSupabase();
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.push("/login"); return; }

      const [studentsQ, docsQ, acadsQ, chedQ] = await Promise.all([
        sb.from("student_accounts")
          .select("student_id, student_number, given_name, last_name, middle_name, year_level")
          .order("last_name", { ascending: true }),
        sb.from("support_documents")
          .select("*, scholarship_applications(student_accounts(student_id, student_number, given_name, last_name, middle_name, year_level))")
          .order("upload_date", { ascending: false }),
        sb.from("support_academic_records")
          .select("*, student_accounts(student_id, student_number, given_name, last_name, middle_name, year_level)")
          .order("created_at", { ascending: false }),
        sb.from("ched_form_input")
          .select("*, scholarship_applications(scholarship_id, scholarship_programs(scholarship_name), student_accounts(student_id, student_number, given_name, last_name, middle_name, year_level))")
          .order("ched_form_id", { ascending: false }),
      ]);

      const loadedDocs = docsQ.data || [];
      const loadedAcads = acadsQ.data || [];
      const loadedChed = chedQ.data || [];

      if (!studentsQ.error) setStudents(studentsQ.data || []);
      if (!docsQ.error) setDocs(loadedDocs);
      if (!acadsQ.error) setAcads(loadedAcads);
      if (!chedQ.error) setChedForms(loadedChed);

      const map: Record<string, string> = {};
      const signBatch = async (bucket: string, paths: (string | null | undefined)[]) => {
        const uniq = [...new Set(paths.filter((p): p is string => !!p))];
        if (!uniq.length) return;
        const { data, error } = await sb.storage.from(bucket).createSignedUrls(uniq, 3600);
        if (error || !data) return;
        for (const item of data) {
          if (item?.signedUrl && item?.path) map[item.path] = item.signedUrl;
        }
      };
      await Promise.all([
        signBatch("support-documents", loadedDocs.map((d) => d.file_path)),
        signBatch("academic-records", loadedAcads.map((a) => a.proof_image_path)),
        signBatch("itr-documents", loadedChed.map((c) => c.income_tax_return)),
      ]);
      if (!ignore) {
        setFileUrls(map);
        setLoading(false);
      }
    }
    startFetching();
    return () => { ignore = true; };
  }, [router]);

  function buildFileName(kind: string, s?: StudentAccount, path?: string) {
    const who = s?.student_number || `${s?.last_name || "student"}${s?.given_name || ""}`;
    const ext = (path?.split("/").pop()?.split(".").pop() || "file").toLowerCase();
    return safeFile(`${kind}_${who}.${ext}`);
  }

  async function downloadOne(url: string, name: string) {
    try {
      const blob = await fetch(url).then((r) => r.blob());
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(obj);
    } catch {
      setFlash({ type: "err", text: `Could not download ${name}. The signed link may have expired — refresh the page and try again.` });
    }
  }

  async function downloadAll(files: { url: string; name: string }[]) {
    if (dlBusy || !files.length) return;
    setDlBusy(true);
    setDlProgress({ done: 0, total: files.length });
    try {
      const zip = new JSZip();
      const usedNames = new Map<string, number>();
      for (const f of files) {
        let name = f.name.split("/").pop() || `file-${Date.now()}`;
        const count = usedNames.get(name) ?? 0;
        usedNames.set(name, count + 1);
        if (count > 0) {
          const dot = name.lastIndexOf(".");
          name = dot > -1 ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : `${name}-${count}`;
        }
        try {
          const blob = await fetch(f.url).then((r) => r.blob());
          zip.file(name, blob);
        } catch {
          setFlash({ type: "err", text: `Could not fetch ${name}. The signed link may have expired — refresh the page and try again.` });
        }
        setDlProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const obj = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = `all-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(obj);
      setFlash({ type: "ok", text: `Downloaded ${files.length} file(s) as one ZIP.` });
      toast.success(`Downloaded ${files.length} file(s) as one ZIP.`);
    } finally {
      setDlBusy(false);
    }
  }

  async function deleteOne(kind: Kind, key: number, bucket: string, path: string) {
    if (!confirm("Delete this document permanently? This cannot be undone.")) return;
    setDelBusyKey(`${kind}-${key}`);
    setFlash(null);
    const sb = getSupabase();

    const table = kind === "support" ? "support_documents" : kind === "academic" ? "support_academic_records" : "ched_form_input";
    const idCol = kind === "support" ? "document_id" : kind === "academic" ? "record_id" : "ched_form_id";

    const { error } = await sb.from(table).delete().eq(idCol, key);
    if (!error && path) {
      const { error: storageErr } = await sb.storage.from(bucket).remove([path]);
      if (storageErr) setFlash({ type: "err", text: `Record deleted but storage cleanup failed: ${storageErr.message}` });
    }

    setDelBusyKey(null);
    if (error) { setFlash({ type: "err", text: error.message }); return; }

    if (kind === "support") setDocs((prev) => prev.filter((d) => d.document_id !== key));
    if (kind === "academic") setAcads((prev) => prev.filter((a) => a.record_id !== key));
    if (kind === "itr") setChedForms((prev) => prev.filter((c) => c.ched_form_id !== key));
    setFileUrls((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setFlash({ type: "ok", text: "Document deleted permanently." });
    toast.success("Document deleted permanently.");
  }

  const selectedNumber = selectedStudent
    ? students.find((s) => s.student_id === Number(selectedStudent))?.student_number
    : undefined;

  const studentRows: DocRow[] = useMemo(() => {
    const rows: DocRow[] = [
      ...docs.map((d): DocRow => {
        const s = d.scholarship_applications?.student_accounts;
        const file = d.file_path.split("/").pop() || d.document_type;
        return {
          key: `support-${d.document_id}`,
          kind: "support",
          studentNumber: s?.student_number || "\u2014",
          name: fullName(s),
          year: s?.year_level || "\u2014",
          details: `${d.document_type} \u00b7 ${file}`,
          uploaded: d.upload_date,
          url: fileUrls[d.file_path],
          bucket: "support-documents",
          path: d.file_path,
          deleteId: d.document_id,
          fileLabel: buildFileName("support", s, d.file_path),
        };
      }),
      ...acads.map((a): DocRow => {
        const s = a.student_accounts;
        const grade = a.shs_gwa != null ? `SHS GWA ${a.shs_gwa}` : a.college_gpa != null ? `College GPA ${a.college_gpa}` : "No grade recorded";
        return {
          key: `academic-${a.record_id}`,
          kind: "academic",
          studentNumber: s?.student_number || "\u2014",
          name: fullName(s),
          year: s?.year_level || "\u2014",
          details: `${a.applicant_type} \u00b7 ${grade}`,
          uploaded: a.created_at,
          url: a.proof_image_path ? fileUrls[a.proof_image_path] : undefined,
          bucket: "academic-records",
          path: a.proof_image_path || "",
          deleteId: a.record_id,
          fileLabel: buildFileName("academic", s, a.proof_image_path),
        };
      }),
      ...chedForms.map((c): DocRow => {
        const s = c.scholarship_applications?.student_accounts;
        const name = fullName(s) !== "Student"
          ? fullName(s)
          : `${c.last_name || ""}, ${c.given_name || ""}`.replace(/^, |, $/g, "").trim() || "Student";
        const sch = c.scholarship_applications?.scholarship_programs?.scholarship_name;
        const income = c.annual_income_family ? `\u20b1${Number(c.annual_income_family).toLocaleString()}/yr` : null;
        const file = c.income_tax_return ? c.income_tax_return.split("/").pop() || "" : "";
        const details = [sch || "No scholarship linked", income, `App #${c.application_id}`, file].filter(Boolean).join(" \u00b7 ");
        return {
          key: `itr-${c.ched_form_id}`,
          kind: "itr",
          studentNumber: c.student_id || s?.student_number || "\u2014",
          name,
          year: c.year_level || s?.year_level || "\u2014",
          details,
          uploaded: c.created_at,
          url: c.income_tax_return ? fileUrls[c.income_tax_return] : undefined,
          bucket: "itr-documents",
          path: c.income_tax_return || "",
          deleteId: c.ched_form_id,
          fileLabel: buildFileName("itr", s, c.income_tax_return),
        };
      }),
    ];

    const filtered = selectedNumber ? rows.filter((r) => r.studentNumber === selectedNumber) : rows;
    filtered.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (b.uploaded || "").localeCompare(a.uploaded || "")
    );
    return filtered;
  }, [docs, acads, chedForms, fileUrls, selectedNumber]);

  const rows = useMemo(
    () => (typeFilter === "all" ? studentRows : studentRows.filter((r) => r.kind === typeFilter)),
    [studentRows, typeFilter]
  );

  const kindCount = (k: Kind) => studentRows.filter((r) => r.kind === k).length;

  const allDownloadable: { url: string; name: string }[] = rows
    .filter((r) => r.url)
    .map((r) => ({ url: r.url!, name: r.fileLabel }));

  function exportCsv() {
    downloadCsv(
      "documents.csv",
      rows.map((r, i) => ({
        no: i + 1,
        student_id: r.studentNumber,
        full_name: r.name,
        year_level: r.year,
        type: KIND_META[r.kind].label,
        details: r.details,
        uploaded: formatDateTime(r.uploaded),
        file: r.path.split("/").pop() || "",
      }))
    );
    setFlash({ type: "ok", text: `Exported ${rows.length} document row(s) as CSV.` });
    toast.success(`Exported ${rows.length} document row(s) as CSV.`);
  }

  if (loading) return <Spinner label="Loading documents..." />;

  const cellCls = "border border-[#241012]/10 px-3 py-1.5 align-middle";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#241012]">Documents Viewer</h1>
          <p className="mt-1 text-xs text-[#8B7376]">
            Every submitted file in one list — ITR, academic records, and support documents.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="rounded-xl border border-[#7B1113]/30 px-4 py-2.5 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:opacity-50"
          >
            &#11015; Export CSV
          </button>
          <button
            onClick={() => downloadAll(allDownloadable)}
            disabled={!allDownloadable.length || dlBusy}
            className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2.5 text-xs font-bold text-white shadow-md transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dlBusy ? `Zipping ${dlProgress.done}/${dlProgress.total}...` : `Download all files (${allDownloadable.length}) as ZIP`}
          </button>
        </div>
      </div>

      {flash && (
        <div className={`rounded-xl border px-4 py-3 text-xs font-medium ${flash.type === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
          {flash.text}
        </div>
      )}

      {studentRows.length === 0 ? (
        <EmptyState icon="&#128450;" title="No uploads yet" hint="Files appear here as students upload requirements." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#241012]/[0.07] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#241012]/[0.07] bg-gradient-to-r from-[#FAF7F5] to-white px-5 py-4">
            <div>
              <p className="text-sm font-bold text-[#241012]">Submitted Documents</p>
              <p className="mt-0.5 text-[11px] text-[#6B5458]">
                {studentRows.length} file{studentRows.length === 1 ? "" : "s"} total &middot;{" "}
                <span className="font-semibold text-[#7B1113]">{rows.length} shown</span>
                {" \u00b7 "}
                <span className="text-[#6B5458]">View opens a preview &middot; Download saves the file &middot; Delete removes it permanently</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="text-xs font-semibold text-[#241012]">
                <select
                  value={selectedStudent}
                  onChange={(e) => setSelectedStudent(e.target.value)}
                  className="block w-full min-w-64 rounded-xl border border-[#241012]/10 bg-white px-3.5 py-2.5 text-xs outline-none transition focus:border-[#7B1113] focus:ring-4 focus:ring-[#7B1113]/10"
                >
                  <option value="">All students</option>
                  {students.map((s) => (
                    <option key={s.student_id} value={s.student_id}>
                      {s.last_name}, {s.given_name} ({s.student_number || "no ID"})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-[#241012]/[0.07] bg-[#FAF7F5]/60 px-5 py-3">
            {([["all", "All files"], ["itr", "ITR"], ["academic", "Academic Record"], ["support", "Support Document"]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTypeFilter(k)}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                  typeFilter === k
                    ? "bg-[#7B1113] text-white shadow-sm"
                    : "border border-[#241012]/10 bg-white text-[#6B5458] hover:bg-[#7B1113]/5"
                }`}
              >
                {label} <span className={typeFilter === k ? "text-white/70" : "text-[#8B7376]"}>{k === "all" ? studentRows.length : kindCount(k)}</span>
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-[#8B7376]">No files match this filter.</p>
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full min-w-[980px] border-collapse text-left text-[11px] text-[#241012]">
                <thead className="sticky top-0 z-10 bg-[#FAF7F5] text-[10px] uppercase tracking-wide text-[#6B5458]">
                  <tr>
                    <th className={`${cellCls} w-12 text-center font-bold`}>#</th>
                    <th className={`${cellCls} font-bold`}>Student ID</th>
                    <th className={`${cellCls} font-bold`}>Full Name</th>
                    <th className={`${cellCls} w-16 font-bold`}>Year</th>
                    <th className={`${cellCls} font-bold`}>Type</th>
                    <th className={`${cellCls} font-bold`}>Details</th>
                    <th className={`${cellCls} font-bold`}>Uploaded</th>
                    <th className={`${cellCls} w-56 font-bold`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.key} className={i % 2 ? "bg-[#FAF7F5]/60" : "bg-white"}>
                      <td className={`${cellCls} text-center font-bold text-[#6B5458]`}>{i + 1}</td>
                      <td className={`${cellCls} whitespace-nowrap font-semibold`}>{r.studentNumber}</td>
                      <td className={`${cellCls} whitespace-nowrap font-bold text-[#241012]`}>{r.name}</td>
                      <td className={`${cellCls} whitespace-nowrap text-center`}>{r.year}</td>
                      <td className={cellCls}>
                        <Badge className={KIND_META[r.kind].cls}>{KIND_META[r.kind].label}</Badge>
                      </td>
                      <td className={`${cellCls} max-w-[320px] truncate text-[#6B5458]`} title={r.details}>
                        {r.details}
                      </td>
                      <td className={`${cellCls} whitespace-nowrap text-[#6B5458]`}>{formatDateTime(r.uploaded)}</td>
                      <td className={cellCls}>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => r.url && setPreview({ url: r.url, name: r.path.split("/").pop() || KIND_META[r.kind].label, bucket: r.bucket, path: r.path })}
                            disabled={!r.url}
                            className="rounded-md bg-[#7B1113] px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-[#540111] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            View
                          </button>
                          <button
                            onClick={() => r.url && downloadOne(r.url, r.fileLabel)}
                            disabled={!r.url || dlBusy}
                            className="rounded-md border border-[#7B1113]/25 px-2.5 py-1 text-[10px] font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Download
                          </button>
                          <button
                            onClick={() => deleteOne(r.kind, r.deleteId, r.bucket, r.path)}
                            disabled={delBusyKey === r.key}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                          >
                            {delBusyKey === r.key ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#241012]/[0.07] bg-[#FAF7F5] px-5 py-2.5 text-[10px] text-[#6B5458]">
            <span>Support documents <b className="text-[#7B1113]">{kindCount("support")}</b></span>
            <span>Academic records <b className="text-[#7B1113]">{kindCount("academic")}</b></span>
            <span>ITR submissions <b className="text-[#7B1113]">{kindCount("itr")}</b></span>
            <span className="ml-auto">Files ready <b className="text-[#7B1113]">{allDownloadable.length}</b> of {rows.length} shown</span>
          </div>
        </div>
      )}

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[#241012]/[0.06] px-5 py-3">
              <p className="truncate text-xs font-bold text-[#241012]">{preview.name}</p>
              <button
                onClick={() => setPreview(null)}
                className="rounded-full p-1 text-lg leading-none text-[#8B7376] transition hover:bg-[#7B1113]/5 hover:text-[#7B1113]"
              >
                &times;
              </button>
            </div>
            <div className="flex max-h-[70vh] items-center justify-center overflow-hidden bg-[#241012]/95 p-2">
              {isImagePath(preview.path) ? (
                <img src={preview.url} alt={preview.name} className="max-h-[68vh] w-auto object-contain" />
              ) : (
                <iframe src={preview.url} title={preview.name} className="h-[68vh] w-full rounded-lg" />
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3">
              <a
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-[#7B1113]/30 px-4 py-2 text-xs font-bold text-[#7B1113] transition hover:bg-[#7B1113]/5"
              >
                Open original
              </a>
              <button
                onClick={() => downloadOne(preview.url, preview.name)}
                disabled={dlBusy}
                className="rounded-xl bg-gradient-to-r from-[#7B1113] to-[#540111] px-4 py-2 text-xs font-bold text-white shadow-md transition hover:brightness-110 disabled:opacity-50"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

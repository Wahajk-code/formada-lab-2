import { redirect } from "next/navigation";

/** The card history moved into the Archive (Formada.AI design). */
export default function HistoryPage() {
  redirect("/archive?tab=cards");
}

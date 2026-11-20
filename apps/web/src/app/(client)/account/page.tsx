import { redirect } from "next/navigation";

/** The account page is now Settings (Formada.AI design). */
export default function AccountPage() {
  redirect("/settings");
}

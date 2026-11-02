import { redirect } from "next/navigation";

// The organizations a person belongs to are listed in their own settings.
export default function OrganizationsPage() {
  redirect("/settings/organizations");
}

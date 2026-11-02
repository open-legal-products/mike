import { redirect } from "next/navigation";

// An organization has no page of its own any more: its work is in the main
// lists once its workspace is active, and everything about the organization
// itself is in its settings. Old links land there.
export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/organizations/${id}/settings`);
}

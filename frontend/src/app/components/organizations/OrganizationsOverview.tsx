"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  type TableSortDirection,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
  acceptOrgInvitation,
  declineOrgInvitation,
  listMyOrgInvitations,
  listOrgs,
  type Org,
  type OrgInvitation,
} from "@/app/lib/mikeApi";
import { type OrgRole } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { LIQUID_SUBTLE_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { CreateOrganizationModal } from "./OrganizationModals";

type OrganizationFilter = "managed" | "joined" | "invites";
type OrganizationSortKey = "name" | "members" | "created";

const SORT_OPTIONS = [
  { value: "asc" as TableSortDirection, labelKey: "crescente" },
  { value: "desc" as TableSortDirection, labelKey: "decrescente" },
];

const PAPEL_KEYS: Record<OrgRole, string> = {
  admin: "papelAdmin",
  member: "papelMembro",
};

function withLabels<T extends { labelKey: string }>(
  options: T[],
  t: (key: string) => string,
): (Omit<T, "labelKey"> & { label: string })[] {
  return options.map(({ labelKey, ...rest }) => ({
    ...rest,
    label: t(labelKey),
  }));
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function OrganizationsOverview() {
  const router = useRouter();
  const t = useTranslations("organizations.overview");
  const tg = useTranslations("organizations.geral");
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeFilter, setActiveFilter] =
    useState<OrganizationFilter>("managed");
  const [sort, setSort] = useState<{
    key: OrganizationSortKey;
    direction: TableSortDirection;
  } | null>(null);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextOrgs, nextInvitations] = await Promise.all([
        listOrgs(),
        listMyOrgInvitations().catch(() => [] as OrgInvitation[]),
      ]);
      setOrgs(nextOrgs);
      setInvitations(nextInvitations);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to load organizations", error);
      setLoadError(t("erroCarregamento"));
      setOrgs([]);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function answer(invitation: OrgInvitation, accept: boolean) {
    setAnsweringId(invitation.id);
    setInvitationError(null);
    try {
      if (accept) await acceptOrgInvitation(invitation.id);
      else await declineOrgInvitation(invitation.id);
      await load();
    } catch (error) {
      setInvitationError(
        userFacingApiError(error, t("erroConvite")),
      );
      await load();
    } finally {
      setAnsweringId(null);
    }
  }

  const loading = orgs === null;
  const organizationFilters = useMemo<
    { id: OrganizationFilter; label: string }[]
  >(
    () => [
      { id: "managed", label: t("gerenciando") },
      { id: "joined", label: t("participando") },
      {
        id: "invites",
        label:
          invitations.length > 0
            ? t("convitesComContagem", { count: invitations.length })
            : t("convites"),
      },
    ],
    [invitations.length, t],
  );
  const visibleOrgs = useMemo(() => {
    if (activeFilter === "invites") return [];
    const filtered = (orgs ?? []).filter((org) =>
      activeFilter === "managed" ? org.role === "admin" : org.role !== "admin",
    );
    if (!sort) return filtered;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * multiplier;
      if (sort.key === "members")
        return ((a.member_count ?? 0) - (b.member_count ?? 0)) * multiplier;
      return (
        (new Date(a.created_at ?? 0).getTime() -
          new Date(b.created_at ?? 0).getTime()) *
        multiplier
      );
    });
  }, [activeFilter, orgs, sort]);
  function setSortFor(
    key: OrganizationSortKey,
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        actions={[
          {
            type: "new",
            title: tg("novaOrganizacao"),
            onClick: () => setCreateOpen(true),
          },
        ]}
      >
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          {t("titulo")}
        </h1>
      </PageHeader>

      <TableToolbar
        items={organizationFilters}
        active={activeFilter}
        onChange={setActiveFilter}
      />

      {activeFilter === "invites" ? (
        loading ? (
          <div
            className={`mx-4 mb-3 space-y-4 rounded-2xl px-4 py-4 md:mx-8 ${LIQUID_SUBTLE_PANEL_SURFACE_CLASS}`}
          >
            {[1, 2, 3].map((row) => (
              <SkeletonLine key={row} className="h-7 w-full" />
            ))}
          </div>
        ) : invitations.length === 0 ? (
          <div className="mx-4 mb-3 flex min-h-0 flex-1 items-center justify-center md:mx-8">
            <EmptyState
              title={t("convitesTitulo")}
              description={t("semConvitesAtivos")}
            />
          </div>
        ) : (
          <div
            className={`mx-4 mb-3 rounded-2xl px-4 py-3 md:mx-8 ${LIQUID_SUBTLE_PANEL_SURFACE_CLASS}`}
          >
            <div className="min-w-0 space-y-3">
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <p className="min-w-0 flex-1 text-xs text-gray-600">
                    <span className="font-medium text-gray-800">
                      {invitation.org_name ?? t("umaOrganizacao")}
                    </span>{" "}
                    {t("convidouComo", {
                      organizacao: invitation.org_name ?? t("umaOrganizacao"),
                      papel: tg(PAPEL_KEYS[invitation.role]),
                    })}
                  </p>
                  <div className="flex gap-2">
                    <PillButton
                      tone="black"
                      size="sm"
                      disabled={answeringId === invitation.id}
                      loading={answeringId === invitation.id}
                      onClick={() => void answer(invitation, true)}
                    >
                      <Check className="h-3.5 w-3.5" />
                      {t("aceitar")}
                    </PillButton>
                    <PillButton
                      tone="white"
                      size="sm"
                      disabled={answeringId === invitation.id}
                      onClick={() => void answer(invitation, false)}
                    >
                      {t("recusar")}
                    </PillButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : (
        <TableScrollArea
          header={
            <TableHeaderRow>
              <TableStickyCell header>
                <span className="mr-1">{tg("colunaNome")}</span>
                {!loading ? (
                  <TableFilters
                    label={t("ordenarPorNome")}
                    value={sort?.key === "name" ? sort.direction : null}
                    allLabel={tg("ordemPadrao")}
                    options={withLabels(SORT_OPTIONS, tg)}
                    align="right"
                    widthClassName="w-40"
                    onChange={(direction) => setSortFor("name", direction)}
                  />
                ) : null}
              </TableStickyCell>
              <TableHeaderCell className="ml-auto w-32">
                <span className="mr-1">{t("colunaMembros")}</span>
                {!loading ? (
                  <TableFilters
                    label={t("ordenarPorMembros")}
                    value={sort?.key === "members" ? sort.direction : null}
                    allLabel={tg("ordemPadrao")}
                    options={withLabels(SORT_OPTIONS, tg)}
                    widthClassName="w-40"
                    onChange={(direction) => setSortFor("members", direction)}
                  />
                ) : null}
              </TableHeaderCell>
              <TableHeaderCell className="w-36">
                <span className="mr-1">{tg("colunaCriacao")}</span>
                {!loading ? (
                  <TableFilters
                    label={t("ordenarPorCriacao")}
                    value={sort?.key === "created" ? sort.direction : null}
                    allLabel={tg("ordemPadrao")}
                    options={withLabels(SORT_OPTIONS, tg)}
                    widthClassName="w-40"
                    onChange={(direction) => setSortFor("created", direction)}
                  />
                ) : null}
              </TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {loading ? (
            <TableBody>
              {[1, 2, 3].map((row) => (
                <TableRow key={row} interactive={false}>
                  <TableStickyCell
                    hover={false}
                    bgClassName="bg-transparent"
                    className="items-center"
                  >
                    <SkeletonLine className="w-44" />
                  </TableStickyCell>
                  <TableCell className="ml-auto w-32">
                    <SkeletonLine className="w-12" />
                  </TableCell>
                  <TableCell className="w-36">
                    <SkeletonLine className="w-20" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          ) : loadError ? (
            <TableEmptyState>
              <EmptyState
                icon={<OrganizationSkeuoIcon />}
                title={t("titulo")}
                description={loadError}
                tone="error"
                action={
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => void load()}
                  >
                    {tg("tentarNovamente")}
                  </PillButton>
                }
              />
            </TableEmptyState>
          ) : orgs.length === 0 ? (
            <TableEmptyState>
              <EmptyState
                icon={<OrganizationSkeuoIcon />}
                title={t("titulo")}
                description={t("estadoVazioDescricao")}
                action={
                  <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                  >
                    {tg("criar")}
                  </PillButton>
                }
              />
            </TableEmptyState>
          ) : visibleOrgs.length === 0 ? (
            <TableEmptyState>
              <p className="text-sm text-gray-400">
                {activeFilter === "managed"
                  ? t("semGerenciadas")
                  : t("semParticipantes")}
              </p>
            </TableEmptyState>
          ) : (
            <TableBody>
              {visibleOrgs.map((org) => (
                <TableRow
                  key={org.id}
                  role="link"
                  tabIndex={0}
                  aria-label={t("abrir", { nome: org.name })}
                  onClick={() => router.push(`/organizations/${org.id}`)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/organizations/${org.id}`);
                    }
                  }}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                >
                  <TableStickyCell className="items-center">
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                      {org.name}
                    </span>
                  </TableStickyCell>
                  <TableCell className="ml-auto w-32">
                    {t("contagemMembros", { count: org.member_count ?? 0 })}
                  </TableCell>
                  <TableCell className="w-36">
                    {formatDate(org.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          )}
        </TableScrollArea>
      )}

      <CreateOrganizationModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(org) => {
          setCreateOpen(false);
          router.push(`/organizations/${org.id}`);
        }}
      />
      <WarningPopup
        open={invitationError !== null}
        title={t("erroConviteTitulo")}
        message={invitationError}
        onClose={() => setInvitationError(null)}
      />
    </div>
  );
}

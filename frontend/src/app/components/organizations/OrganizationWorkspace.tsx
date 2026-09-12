"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Check, ChevronDown, Loader2, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAuth } from "@/app/contexts/AuthContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import {
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  type TableFilterOption,
  type TableSortDirection,
} from "@/app/components/shared/TablePrimitive";
import {
  OrganizationSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ClosedProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  LiquidDropdownContent,
  LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import {
  getOrg,
  listOrgInvitations,
  listOrgMembers,
  listOrgResources,
  removeOrgMember,
  updateOrgMember,
  type Org,
  type OrgInvitation,
  type OrgMember,
  type OrgResources,
} from "@/app/lib/mikeApi";
import { type OrgRole } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
  InviteOrganizationMemberModal,
  OrganizationSettingsModal,
} from "./OrganizationModals";

type OrganizationTab = "people" | "projects" | "workflows";

const TABS: { id: OrganizationTab; labelKey: string }[] = [
  { id: "people", labelKey: "abaPessoas" },
  { id: "projects", labelKey: "abaProjetos" },
  { id: "workflows", labelKey: "abaWorkflows" },
];

const EMPTY_RESOURCES: OrgResources = { projects: [], workflows: [] };

const SORT_OPTIONS = [
  { value: "asc" as TableSortDirection, labelKey: "crescente" },
  { value: "desc" as TableSortDirection, labelKey: "decrescente" },
];

const ROLE_FILTER_OPTIONS = [
  { value: "admin" as OrgRole, labelKey: "papelAdmin", className: "text-blue-700" },
  { value: "member" as OrgRole, labelKey: "papelMembro", className: "text-violet-700" },
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

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function resourceName(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

export function OrganizationWorkspace({ orgId }: { orgId: string }) {
  const router = useRouter();
  const t = useTranslations("organizations.workspace");
  const tg = useTranslations("organizations.geral");
  const { user } = useAuth();
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [resources, setResources] = useState<OrgResources>(EMPTY_RESOURCES);
  const [activeTab, setActiveTab] = useState<OrganizationTab>("people");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [removeSelectedOpen, setRemoveSelectedOpen] = useState(false);
  const [removingSelected, setRemovingSelected] = useState(false);
  const [removeMember, setRemoveMember] = useState<OrgMember | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const nextOrg = await getOrg(orgId);
      const [nextMembers, nextResources, nextInvitations] = await Promise.all([
        listOrgMembers(orgId),
        listOrgResources(orgId),
        nextOrg.role === "admin"
          ? listOrgInvitations(orgId)
          : Promise.resolve([] as OrgInvitation[]),
      ]);
      setOrg({ ...nextOrg, member_count: nextMembers.length });
      setMembers(nextMembers);
      setResources(nextResources);
      setInvitations(nextInvitations);
    } catch (error) {
      console.error("Failed to load organization", error);
      setLoadError(
        userFacingApiError(error, t("erroCarregamento")),
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  const refreshInvitations = useCallback(async () => {
    if (org?.role !== "admin") return;
    setInvitations(await listOrgInvitations(orgId));
  }, [org?.role, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = org?.role === "admin";

  async function changeRole(member: OrgMember, role: OrgRole) {
    if (!isAdmin || member.role === role || busyMemberId) return;
    setBusyMemberId(member.user_id);
    setActionError(null);
    try {
      await updateOrgMember(orgId, member.user_id, role);
      setMembers((current) =>
        current.map((row) =>
          row.user_id === member.user_id ? { ...row, role } : row,
        ),
      );
    } catch (error) {
      setActionError(userFacingApiError(error, t("erroMudarPapel")));
    } finally {
      setBusyMemberId(null);
    }
  }

  async function confirmRemoveMember() {
    if (!removeMember || busyMemberId) return;
    const member = removeMember;
    setBusyMemberId(member.user_id);
    setActionError(null);
    try {
      await removeOrgMember(orgId, member.user_id);
      if (member.user_id === user?.id) {
        router.push("/organizations");
        return;
      }
      setMembers((current) =>
        current.filter((row) => row.user_id !== member.user_id),
      );
      setSelectedMemberIds((current) =>
        current.filter((id) => id !== member.id),
      );
      setRemoveMember(null);
    } catch (error) {
      setActionError(
        userFacingApiError(error, t("erroRemoverMembro")),
      );
      setRemoveMember(null);
    } finally {
      setBusyMemberId(null);
    }
  }

  function requestRemoveSelected() {
    if (!isAdmin || selectedMemberIds.length === 0) return;
    const selectedMembers = members.filter((member) =>
      selectedMemberIds.includes(member.id),
    );
    if (selectedMembers.some((member) => member.user_id === user?.id)) {
      setActionError(t("erroManterAdmin"));
      return;
    }
    setRemoveSelectedOpen(true);
  }

  async function confirmRemoveSelected() {
    if (!isAdmin || removingSelected || selectedMemberIds.length === 0) return;
    const selectedMembers = members.filter((member) =>
      selectedMemberIds.includes(member.id),
    );
    setRemovingSelected(true);
    setActionError(null);
    const results = await Promise.allSettled(
      selectedMembers.map((member) => removeOrgMember(orgId, member.user_id)),
    );
    const removedIds = selectedMembers
      .filter((_, index) => results[index]?.status === "fulfilled")
      .map((member) => member.id);
    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setMembers((current) =>
      current.filter((member) => !removedIds.includes(member.id)),
    );
    setSelectedMemberIds((current) =>
      current.filter((id) => !removedIds.includes(id)),
    );
    if (firstFailure) {
      setActionError(
        userFacingApiError(
          firstFailure.reason,
          t("erroRemoverSelecionados"),
        ),
      );
    }
    setRemoveSelectedOpen(false);
    setRemovingSelected(false);
  }

  const peopleToolbarActions =
    activeTab === "people" && isAdmin && selectedMemberIds.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TabPillButton>
            {t("acoes")}
            <ChevronDown className="h-3.5 w-3.5" />
          </TabPillButton>
        </DropdownMenuTrigger>
        <LiquidDropdownContent align="end" className="z-[130] w-44">
          <LiquidDropdownItem
            onSelect={requestRemoveSelected}
            className="text-red-600 focus:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5 text-red-600" />
            {t("removerSelecionados")}
          </LiquidDropdownItem>
        </LiquidDropdownContent>
      </DropdownMenu>
    ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        breadcrumbs={[
          {
            label: tg("organizacoes"),
            onClick: () => router.push("/organizations"),
            title: t("voltarOrganizacoes"),
          },
          org
            ? { label: org.name, cursor: "text" }
            : { loading: true, skeletonClassName: "w-40" },
        ]}
        actionGroups={[
          [
            {
              type: "new",
              title: isAdmin
                ? tg("adicionarMembro")
                : t("somenteAdminsAdicionam"),
              disabled: !isAdmin,
              onClick: () => setInviteOpen(true),
            },
            isAdmin
              ? {
                  type: "custom",
                  render: (
                    <HeaderActionsMenu
                      title={t("configuracoesOrganizacao")}
                      items={[
                        {
                          label: t("configuracoesOrganizacao"),
                          icon: Pencil,
                          onSelect: () => setSettingsOpen(true),
                        },
                      ]}
                    />
                  ),
                }
              : null,
          ],
        ]}
      />

      <TableToolbar
        items={TABS.map(({ labelKey, ...rest }) => ({
          ...rest,
          label: t(labelKey),
        }))}
        active={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setSelectedMemberIds([]);
        }}
        actions={peopleToolbarActions}
      />

      {activeTab === "people" ? (
        <PeopleTable
          loading={loading}
          error={loadError}
          members={members}
          selectedMemberIds={selectedMemberIds}
          onSelectedMemberIdsChange={setSelectedMemberIds}
          currentUserId={user?.id ?? null}
          isAdmin={isAdmin}
          busyMemberId={busyMemberId}
          onRetry={load}
          onRoleChange={changeRole}
          onRemove={setRemoveMember}
        />
      ) : activeTab === "projects" ? (
        <ResourceTable
          key="projects"
          loading={loading}
          error={loadError}
          kind="projects"
          rows={resources.projects.map((project) => ({
            id: project.id,
            name: resourceName(project.name, t("projetoSemNome")),
            context: project.practice || "—",
            createdAt: project.created_at,
            href: `/projects/${project.id}`,
          }))}
          onRetry={load}
        />
      ) : (
        <ResourceTable
          key="workflows"
          loading={loading}
          error={loadError}
          kind="workflows"
          rows={resources.workflows.map((workflow) => ({
            id: workflow.id,
            name: resourceName(workflow.title, t("workflowSemNome")),
            context:
              workflow.type === "tabular"
                ? t("contextoTabular")
                : t("contextoAssistente"),
            createdAt: workflow.created_at,
            href: `/workflows/${workflow.id}`,
          }))}
          onRetry={load}
        />
      )}

      {org ? (
        <>
          <InviteOrganizationMemberModal
            open={inviteOpen}
            org={org}
            invitations={invitations}
            onClose={() => setInviteOpen(false)}
            onChanged={refreshInvitations}
          />
          <OrganizationSettingsModal
            open={settingsOpen}
            org={org}
            onClose={() => setSettingsOpen(false)}
            onUpdated={(updated) => {
              setOrg((current) => ({
                ...updated,
                member_count: current?.member_count,
              }));
              setSettingsOpen(false);
            }}
            onDeleted={() => router.push("/organizations")}
          />
        </>
      ) : null}

      <ConfirmPopup
        open={removeMember !== null}
        title={
          removeMember?.user_id === user?.id
            ? t("sairOrganizacaoTitulo")
            : t("removerMembroTitulo")
        }
        message={
          removeMember?.user_id === user?.id
            ? t("sairOrganizacaoMensagem")
            : t("removerMembroMensagem", {
                nome:
                  removeMember?.display_name ||
                  removeMember?.email ||
                  t("membroFallback"),
              })
        }
        confirmLabel={
          removeMember?.user_id === user?.id ? t("sair") : t("remover")
        }
        confirmVariant="danger"
        confirmStatus={busyMemberId ? "loading" : "idle"}
        onCancel={() => setRemoveMember(null)}
        onConfirm={() => void confirmRemoveMember()}
      />
      <ConfirmPopup
        open={removeSelectedOpen}
        title={t("removerSelecionadosTitulo")}
        message={t("removerSelecionadosMensagem", {
          count: selectedMemberIds.length,
        })}
        confirmLabel={t("remover")}
        confirmVariant="danger"
        confirmStatus={removingSelected ? "loading" : "idle"}
        onCancel={() => setRemoveSelectedOpen(false)}
        onConfirm={() => void confirmRemoveSelected()}
      />
      <WarningPopup
        open={actionError !== null}
        title={t("erroAcaoTitulo")}
        message={actionError}
        onClose={() => setActionError(null)}
      />
    </div>
  );
}

function PeopleTable({
  loading,
  error,
  members,
  selectedMemberIds,
  onSelectedMemberIdsChange,
  currentUserId,
  isAdmin,
  busyMemberId,
  onRetry,
  onRoleChange,
  onRemove,
}: {
  loading: boolean;
  error: string | null;
  members: OrgMember[];
  selectedMemberIds: string[];
  onSelectedMemberIdsChange: Dispatch<SetStateAction<string[]>>;
  currentUserId: string | null;
  isAdmin: boolean;
  busyMemberId: string | null;
  onRetry: () => Promise<void>;
  onRoleChange: (member: OrgMember, role: OrgRole) => Promise<void>;
  onRemove: (member: OrgMember) => void;
}) {
  const t = useTranslations("organizations.workspace");
  const tg = useTranslations("organizations.geral");
  const [roleFilter, setRoleFilter] = useState<OrgRole | null>(null);
  const [sort, setSort] = useState<{
    key: "name" | "email" | "added";
    direction: TableSortDirection;
  } | null>(null);
  const sortOptions = withLabels(SORT_OPTIONS, tg);
  const roleOptions = withLabels(ROLE_FILTER_OPTIONS, tg);
  const visibleMembers = useMemo(() => {
    const filtered = roleFilter
      ? members.filter((member) => member.role === roleFilter)
      : members;
    if (!sort) return filtered;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "added") {
        return (
          (new Date(a.created_at ?? 0).getTime() -
            new Date(b.created_at ?? 0).getTime()) *
          multiplier
        );
      }
      const aValue =
        sort.key === "email"
          ? (a.email ?? "")
          : a.display_name || a.email || a.user_id;
      const bValue =
        sort.key === "email"
          ? (b.email ?? "")
          : b.display_name || b.email || b.user_id;
      return aValue.localeCompare(bValue) * multiplier;
    });
  }, [members, roleFilter, sort]);
  const allSelected =
    visibleMembers.length > 0 &&
    visibleMembers.every((member) => selectedMemberIds.includes(member.id));
  const someSelected =
    !allSelected &&
    visibleMembers.some((member) => selectedMemberIds.includes(member.id));

  function setSortFor(
    key: "name" | "email" | "added",
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
    onSelectedMemberIdsChange([]);
  }

  function toggleAllVisible() {
    const visibleIds = visibleMembers.map((member) => member.id);
    onSelectedMemberIdsChange((current) =>
      allSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }

  function toggleMember(memberId: string) {
    onSelectedMemberIdsChange((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId],
    );
  }

  return (
    <TableScrollArea
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                onChange={toggleAllVisible}
                className={TABLE_CHECKBOX_CLASS}
                aria-label={t("selecionarTodasPessoas")}
              />
            )}
            <span className="mr-1">{t("colunaUsuario")}</span>
            {!loading ? (
              <TableFilters
                label={t("ordenarPorUsuario")}
                value={sort?.key === "name" ? sort.direction : null}
                allLabel={tg("ordemPadrao")}
                options={sortOptions}
                align="right"
                widthClassName="w-40"
                onChange={(direction) => setSortFor("name", direction)}
              />
            ) : null}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-64">
            <span className="mr-1">{t("colunaEmail")}</span>
            {!loading ? (
              <TableFilters
                label={t("ordenarPorEmail")}
                value={sort?.key === "email" ? sort.direction : null}
                allLabel={tg("ordemPadrao")}
                options={sortOptions}
                widthClassName="w-40"
                onChange={(direction) => setSortFor("email", direction)}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-32">
            <span className="mr-1">{t("colunaPapel")}</span>
            {!loading ? (
              <TableFilters
                label={t("filtrarPorPapel")}
                value={roleFilter}
                allLabel={t("todosOsPapeis")}
                options={roleOptions}
                widthClassName="w-36"
                onChange={(role) => {
                  setRoleFilter(role);
                  onSelectedMemberIdsChange([]);
                }}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-36">
            <span className="mr-1">{t("colunaAdicionado")}</span>
            {!loading ? (
              <TableFilters
                label={t("ordenarPorAdicao")}
                value={sort?.key === "added" ? sort.direction : null}
                allLabel={tg("ordemPadrao")}
                options={sortOptions}
                widthClassName="w-40"
                onChange={(direction) => setSortFor("added", direction)}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-10" />
        </TableHeaderRow>
      }
    >
      {loading ? (
        <LoadingRows columns={["w-64", "w-32", "w-36", "w-10"]} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : members.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={<OrganizationSkeuoIcon />}
            title={t("abaPessoas")}
            description={t("semMembros")}
          />
        </TableEmptyState>
      ) : visibleMembers.length === 0 ? (
        <TableEmptyState>
          <p className="text-sm text-gray-400">{t("nenhumaPessoaFiltro")}</p>
        </TableEmptyState>
      ) : (
        <TableBody>
          {visibleMembers.map((member) => {
            const label = member.display_name || member.email || member.user_id;
            const canRemove = isAdmin || member.user_id === currentUserId;
            const isSelected = selectedMemberIds.includes(member.id);
            return (
              <TableRow
                key={member.id}
                interactive={false}
                selected={isSelected}
                className={!isSelected ? LIQUID_GLASS_HOVER_CLASS : undefined}
              >
                <TablePrimaryCell
                  selected={isSelected}
                  onSelectionChange={() => toggleMember(member.id)}
                  checkboxTitle={t("selecionar", { nome: label })}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                    {label}
                  </span>
                  {member.user_id === currentUserId ? (
                    <span className="ml-1 text-[10px] text-gray-400">
                      {t("voce")}
                    </span>
                  ) : null}
                </TablePrimaryCell>
                <TableCell className="ml-auto w-64">
                  {member.email || "—"}
                </TableCell>
                <TableCell className="w-32 overflow-visible">
                  <OrganizationRoleTab
                    role={member.role}
                    label={label}
                    editable={isAdmin}
                    disabled={busyMemberId === member.user_id}
                    onChange={(role) => void onRoleChange(member, role)}
                  />
                </TableCell>
                <TableCell className="w-36">
                  {formatDate(member.created_at)}
                </TableCell>
                <TableCell className="flex w-10 justify-end overflow-visible">
                  {canRemove ? (
                    <HeaderActionsMenu
                      title={t("acoesDe", { nome: label })}
                      items={[
                        {
                          label:
                            member.user_id === currentUserId
                              ? t("sairOrganizacao")
                              : t("removerMembro"),
                          icon: Trash2,
                          variant: "danger",
                          onSelect: () => onRemove(member),
                        },
                      ]}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      )}
    </TableScrollArea>
  );
}

function OrganizationRoleTab({
  role,
  label,
  editable,
  disabled,
  onChange,
}: {
  role: OrgRole;
  label: string;
  editable: boolean;
  disabled: boolean;
  onChange: (role: OrgRole) => void;
}) {
  const t = useTranslations("organizations.workspace");
  const tg = useTranslations("organizations.geral");
  const tone =
    role === "admin"
      ? "bg-blue-100 text-blue-700"
      : "bg-violet-100 text-violet-700";
  const className = `inline-flex h-6 min-w-20 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-medium ${tone}`;

  if (!editable) {
    return <span className={className}>{tg(PAPEL_KEYS[role])}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("mudarPapel", { nome: label })}
          disabled={disabled}
          className={`${className} transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-50`}
        >
          <span className="flex-1 text-center">{tg(PAPEL_KEYS[role])}</span>
          {disabled ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )}
        </button>
      </DropdownMenuTrigger>
      <LiquidDropdownContent align="start" className="z-[120] w-36">
        {withLabels(ROLE_FILTER_OPTIONS, tg).map((option) => (
          <LiquidDropdownItem
            key={option.value}
            selected={role === option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between"
          >
            <span className={option.className}>{option.label}</span>
            {role === option.value ? (
              <Check className="h-3.5 w-3.5 text-gray-400" />
            ) : null}
          </LiquidDropdownItem>
        ))}
      </LiquidDropdownContent>
    </DropdownMenu>
  );
}

type ResourceKind = "projects" | "workflows";
type ResourceRow = {
  id: string;
  name: string;
  context: string;
  createdAt: string | null;
  href: string;
};

function ResourceTable({
  loading,
  error,
  kind,
  rows,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  kind: ResourceKind;
  rows: ResourceRow[];
  onRetry: () => Promise<void>;
}) {
  const router = useRouter();
  const t = useTranslations("organizations.workspace");
  const tg = useTranslations("organizations.geral");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [contextFilter, setContextFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{
    key: "name" | "created";
    direction: TableSortDirection;
  } | null>(null);
  const sortOptions = withLabels(SORT_OPTIONS, tg);
  const copy = {
    projects: {
      tipo: t("tipoProjetos"),
      title: t("abaProjetos"),
      context: t("contextoPratica"),
      empty: t("semProjetos"),
      allContexts: t("todasPraticas"),
      noFilterMatch: t("nenhumProjetoFiltro"),
      selectAll: t("selecionarTodosTipo", { tipo: t("tipoProjetos") }),
      icon: <ClosedProjectSvgIcon />,
    },
    workflows: {
      tipo: t("tipoWorkflows"),
      title: t("abaWorkflows"),
      context: t("contextoTipo"),
      empty: t("semWorkflows"),
      allContexts: t("todosOsTipos"),
      noFilterMatch: t("nenhumWorkflowFiltro"),
      selectAll: t("selecionarTodosTipo", { tipo: t("tipoWorkflows") }),
      icon: <WorkflowSkeuoIcon />,
    },
  }[kind];
  const contextOptions = useMemo<TableFilterOption<string>[]>(
    () =>
      [...new Set(rows.map((row) => row.context))]
        .sort((a, b) => a.localeCompare(b))
        .map((context) => ({ value: context, label: context })),
    [rows],
  );
  const visibleRows = useMemo(() => {
    const filtered = contextFilter
      ? rows.filter((row) => row.context === contextFilter)
      : rows;
    if (!sort) return filtered;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * multiplier;
      return (
        (new Date(a.createdAt ?? 0).getTime() -
          new Date(b.createdAt ?? 0).getTime()) *
        multiplier
      );
    });
  }, [contextFilter, rows, sort]);
  const allSelected =
    visibleRows.length > 0 &&
    visibleRows.every((row) => selectedIds.includes(row.id));
  const someSelected =
    !allSelected && visibleRows.some((row) => selectedIds.includes(row.id));

  function setSortFor(
    key: "name" | "created",
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
    setSelectedIds([]);
  }

  function toggleAllVisible() {
    const visibleIds = visibleRows.map((row) => row.id);
    setSelectedIds((current) =>
      allSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }

  function toggleRow(rowId: string) {
    setSelectedIds((current) =>
      current.includes(rowId)
        ? current.filter((id) => id !== rowId)
        : [...current, rowId],
    );
  }

  return (
    <TableScrollArea
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                onChange={toggleAllVisible}
                className={TABLE_CHECKBOX_CLASS}
                aria-label={copy.selectAll}
              />
            )}
            <span className="mr-1">{tg("colunaNome")}</span>
            {!loading ? (
              <TableFilters
                label={t("ordenarNomePorTipo", { tipo: copy.tipo })}
                value={sort?.key === "name" ? sort.direction : null}
                allLabel={tg("ordemPadrao")}
                options={sortOptions}
                align="right"
                widthClassName="w-40"
                onChange={(direction) => setSortFor("name", direction)}
              />
            ) : null}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-48">
            <span className="mr-1">{copy.context}</span>
            {!loading ? (
              <TableFilters
                label={t("filtrarPorContexto", {
                  tipo: copy.tipo,
                  contexto: copy.context.toLowerCase(),
                })}
                value={contextFilter}
                allLabel={copy.allContexts}
                options={contextOptions}
                widthClassName="w-44"
                onChange={(context) => {
                  setContextFilter(context);
                  setSelectedIds([]);
                }}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-36">
            <span className="mr-1">{tg("colunaCriacao")}</span>
            {!loading ? (
              <TableFilters
                label={t("ordenarCriacaoPorTipo", { tipo: copy.tipo })}
                value={sort?.key === "created" ? sort.direction : null}
                allLabel={tg("ordemPadrao")}
                options={sortOptions}
                widthClassName="w-40"
                onChange={(direction) => setSortFor("created", direction)}
              />
            ) : null}
          </TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {loading ? (
        <LoadingRows columns={["w-48", "w-36"]} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={copy.icon}
            title={copy.title}
            description={copy.empty}
          />
        </TableEmptyState>
      ) : visibleRows.length === 0 ? (
        <TableEmptyState>
          <p className="text-sm text-gray-400">{copy.noFilterMatch}</p>
        </TableEmptyState>
      ) : (
        <TableBody>
          {visibleRows.map((row) => (
            <TableRow
              key={row.id}
              selected={selectedIds.includes(row.id)}
              role="link"
              tabIndex={0}
              aria-label={t("abrir", { nome: row.name })}
              onClick={() => router.push(row.href)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  router.push(row.href);
                }
              }}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
            >
              <TablePrimaryCell
                selected={selectedIds.includes(row.id)}
                onSelectionChange={() => toggleRow(row.id)}
                checkboxTitle={t("selecionar", { nome: row.name })}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                  {row.name}
                </span>
              </TablePrimaryCell>
              <TableCell className="ml-auto w-48">{row.context}</TableCell>
              <TableCell className="w-36">
                {formatDate(row.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      )}
    </TableScrollArea>
  );
}

function LoadingRows({ columns }: { columns: string[] }) {
  return (
    <TableBody>
      {[1, 2, 3].map((row) => (
        <TableRow key={row} interactive={false}>
          <TableStickyCell hover={false} bgClassName="bg-transparent">
            <SkeletonCheckbox />
            <SkeletonLine className="w-40" />
          </TableStickyCell>
          {columns.map((width, index) => (
            <TableCell
              key={`${width}-${index}`}
              className={`${index === 0 ? "ml-auto " : ""}${width}`}
            >
              <SkeletonLine className="w-20" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => Promise<void>;
}) {
  const t = useTranslations("organizations.workspace");
  const tg = useTranslations("organizations.geral");
  return (
    <TableEmptyState>
      <EmptyState
        icon={<OrganizationSkeuoIcon />}
        title={t("tituloOrganizacao")}
        description={error}
        tone="error"
        action={
          <button
            type="button"
            onClick={() => void onRetry()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Loader2 className="h-3.5 w-3.5" />
            {tg("tentarNovamente")}
          </button>
        }
      />
    </TableEmptyState>
  );
}

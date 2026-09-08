(() => {
  interface Sender {
    Id: number;
    senderId: string;
    senderIdType: 'Transactional' | 'Promotional';
    csp: 'grant' | 'lazer' | null;
  }

  type Role = 'super_admin' | 'user';

  interface DashboardUser {
    id: number;
    username: string;
    role: Role;
    is_active: number;
    last_login_at: string | null;
  }

  interface AuditEntry {
    id: number;
    actor_username: string;
    action: string;
    sender_id: string | null;
    before_json: unknown;
    after_json: unknown;
    ip: string | null;
    created_at: string;
  }

  const $ = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

  const bannerError = $<HTMLDivElement>('banner-error');
  const bannerOk = $<HTMLDivElement>('banner-ok');
  const sendersBody = $<HTMLTableSectionElement>('senders-body');
  const sendersEmpty = $<HTMLDivElement>('senders-empty');
  const auditBody = $<HTMLTableSectionElement>('audit-body');
  const auditEmpty = $<HTMLDivElement>('audit-empty');

  const form = $<HTMLFormElement>('sender-form');
  const editId = $<HTMLInputElement>('edit-id');
  const senderIdInput = $<HTMLInputElement>('senderId');
  const typeInput = $<HTMLSelectElement>('senderIdType');
  const cspInput = $<HTMLSelectElement>('csp');
  const saveBtn = $<HTMLButtonElement>('save-btn');
  const cancelBtn = $<HTMLButtonElement>('cancel-btn');
  const formTitle = $<HTMLHeadingElement>('form-title');

  const search = $<HTMLInputElement>('search');
  const filterType = $<HTMLSelectElement>('filter-type');
  const filterCsp = $<HTMLSelectElement>('filter-csp');

  const overlay = $<HTMLDivElement>('confirm-overlay');
  const confirmName = $<HTMLSpanElement>('confirm-name');
  const confirmDelete = $<HTMLButtonElement>('confirm-delete');
  const confirmCancel = $<HTMLButtonElement>('confirm-cancel');

  interface PendingDelete {
    label: string;
    url: string;
    title: string;
    body: string;
    onDone: () => Promise<void>;
  }

  let pendingDelete: PendingDelete | null = null;
  let messageTimer: number | undefined;
  let me: { id: number; username: string; role: Role } | null = null;

  function showError(text: string): void {
    bannerOk.hidden = true;
    bannerError.textContent = text;
    bannerError.hidden = false;
  }

  function showOk(text: string): void {
    bannerError.hidden = true;
    bannerOk.textContent = text;
    bannerOk.hidden = false;
    window.clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => {
      bannerOk.hidden = true;
    }, 4000);
  }

  function clearMessages(): void {
    bannerError.hidden = true;
    bannerOk.hidden = true;
  }

  /** Any 401 means the session lapsed; bounce to the login screen. */
  async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Not authenticated');
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : 'Request failed');
    }
    return body as T;
  }

  /**
   * Renders one pager and reports whether the requested offset was valid.
   * Returns the offset actually in effect, which differs when a delete or a
   * filter change leaves the current page beyond the end of the results.
   */
  function renderPager(
    prefix: string,
    total: number,
    limit: number,
    offset: number,
    noun: string,
  ): void {
    const status = $<HTMLSpanElement>(`${prefix}-status`);
    const prev = $<HTMLButtonElement>(`${prefix}-prev`);
    const next = $<HTMLButtonElement>(`${prefix}-next`);

    if (total === 0) {
      status.textContent = `No ${noun}`;
    } else {
      const first = offset + 1;
      const last = Math.min(offset + limit, total);
      const pages = Math.max(1, Math.ceil(total / limit));
      const page = Math.floor(offset / limit) + 1;
      status.textContent =
        `${first}\u2013${last} of ${total} ${noun}  \u00b7  page ${page} of ${pages}`;
    }
    prev.disabled = offset <= 0;
    next.disabled = offset + limit >= total;
  }

  function td(text: string, className?: string): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  // ---------- senders ----------

  function renderSenders(senders: Sender[]): void {
    sendersBody.replaceChildren();
    sendersEmpty.hidden = senders.length > 0;

    for (const sender of senders) {
      const tr = document.createElement('tr');
      tr.append(
        td(String(sender.Id), 'mono'),
        td(sender.senderId, 'mono'),
        td(sender.senderIdType),
        td(sender.csp ?? '—'),
      );

      const actions = document.createElement('td');
      actions.className = 'actions';

      const edit = document.createElement('button');
      edit.className = 'btn small';
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => startEdit(sender));

      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', () =>
        askDelete({
          label: sender.senderId,
          url: `/api/senders/${sender.Id}`,
          title: 'Delete sender ID?',
          body: 'You are about to permanently delete ',
          onDone: async () => {
            // If the deleted row was loaded into the form, drop it.
            if (editId.value === String(sender.Id)) resetForm();
            await loadSenders();
          },
        }),
      );

      actions.append(edit, del);
      tr.append(actions);
      sendersBody.append(tr);
    }
  }

  const sendersSize = $<HTMLSelectElement>('senders-size');
  let sendersOffset = 0;

  async function loadSenders(): Promise<void> {
    const limit = Number(sendersSize.value);
    const params = new URLSearchParams();
    if (search.value.trim() !== '') params.set('search', search.value.trim());
    if (filterType.value !== '') params.set('type', filterType.value);
    if (filterCsp.value !== '') params.set('csp', filterCsp.value);
    params.set('limit', String(limit));
    params.set('offset', String(sendersOffset));

    try {
      const data = await api<{ senders: Sender[]; total: number; limit: number; offset: number }>(
        `/api/senders?${params.toString()}`,
      );

      // Deleting the last row of the final page (or tightening a filter) can
      // leave the offset past the end of the results. Step back and refetch
      // rather than showing an empty table with rows still available.
      if (data.senders.length === 0 && data.total > 0 && sendersOffset > 0) {
        sendersOffset = Math.max(0, (Math.ceil(data.total / limit) - 1) * limit);
        await loadSenders();
        return;
      }

      renderSenders(data.senders);
      renderPager('senders', data.total, data.limit, data.offset, 'sender IDs');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not load sender IDs');
    }
  }

  $<HTMLButtonElement>('senders-prev').addEventListener('click', () => {
    sendersOffset = Math.max(0, sendersOffset - Number(sendersSize.value));
    void loadSenders();
  });
  $<HTMLButtonElement>('senders-next').addEventListener('click', () => {
    sendersOffset += Number(sendersSize.value);
    void loadSenders();
  });
  sendersSize.addEventListener('change', () => {
    sendersOffset = 0;
    void loadSenders();
  });

  function startEdit(sender: Sender): void {
    clearMessages();
    editId.value = String(sender.Id);
    senderIdInput.value = sender.senderId;
    typeInput.value = sender.senderIdType;
    cspInput.value = sender.csp ?? 'grant';
    formTitle.textContent = `Edit sender ID #${sender.Id}`;
    saveBtn.textContent = 'Save changes';
    cancelBtn.hidden = false;
    senderIdInput.focus();
  }

  function resetForm(): void {
    editId.value = '';
    form.reset();
    formTitle.textContent = 'Add sender ID';
    saveBtn.textContent = 'Create';
    cancelBtn.hidden = true;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearMessages();

    const payload = {
      senderId: senderIdInput.value.trim(),
      senderIdType: typeInput.value,
      csp: cspInput.value,
    };
    if (payload.senderId === '') {
      showError('Sender ID is required');
      return;
    }

    const id = editId.value;
    const isEdit = id !== '';
    saveBtn.disabled = true;

    void (isEdit
      ? api(`/api/senders/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : api('/api/senders', { method: 'POST', body: JSON.stringify(payload) })
    )
      .then(async () => {
        showOk(isEdit ? `Updated "${payload.senderId}"` : `Created "${payload.senderId}"`);
        resetForm();
        await loadSenders();
      })
      .catch((err: unknown) => {
        showError(err instanceof Error ? err.message : 'Save failed');
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  cancelBtn.addEventListener('click', () => {
    clearMessages();
    resetForm();
  });

  // ---------- delete confirmation ----------

  function askDelete(request: PendingDelete): void {
    pendingDelete = request;
    $<HTMLHeadingElement>('confirm-title').textContent = request.title;
    $<HTMLParagraphElement>('confirm-body').textContent = request.body;
    confirmName.textContent = request.label;
    $<HTMLParagraphElement>('confirm-body').append(confirmName, document.createTextNode('.'));
    overlay.hidden = false;
    confirmDelete.focus();
  }

  function closeConfirm(): void {
    pendingDelete = null;
    overlay.hidden = true;
  }

  confirmCancel.addEventListener('click', closeConfirm);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeConfirm();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) closeConfirm();
  });

  confirmDelete.addEventListener('click', () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    confirmDelete.disabled = true;
    clearMessages();

    void api(target.url, { method: 'DELETE' })
      .then(async () => {
        closeConfirm();
        showOk(`Deleted "${target.label}"`);
        await target.onDone();
      })
      .catch((err: unknown) => {
        closeConfirm();
        showError(err instanceof Error ? err.message : 'Delete failed');
      })
      .finally(() => {
        confirmDelete.disabled = false;
      });
  });

  // ---------- users (super admin only) ----------

  const usersBody = $<HTMLTableSectionElement>('users-body');
  const userForm = $<HTMLFormElement>('user-form');
  const newUsername = $<HTMLInputElement>('new-username');
  const newPassword = $<HTMLInputElement>('new-password');
  const newRole = $<HTMLSelectElement>('new-role');
  const userSave = $<HTMLButtonElement>('user-save');

  function roleLabel(role: Role): string {
    return role === 'super_admin' ? 'Super admin' : 'User';
  }

  async function loadUsers(): Promise<void> {
    try {
      const data = await api<{ users: DashboardUser[] }>('/api/users');
      usersBody.replaceChildren();

      for (const user of data.users) {
        const tr = document.createElement('tr');
        const isSelf = me !== null && me.id === user.id;

        tr.append(
          td(user.username + (isSelf ? ' (you)' : ''), 'mono'),
          td(roleLabel(user.role)),
          td(user.is_active === 1 ? 'Active' : 'Disabled'),
          td(user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'never', 'mono'),
        );

        const actions = document.createElement('td');
        actions.className = 'actions';

        const toggleRole = document.createElement('button');
        toggleRole.className = 'btn small';
        toggleRole.type = 'button';
        toggleRole.textContent =
          user.role === 'super_admin' ? 'Make user' : 'Make super admin';
        toggleRole.addEventListener('click', () => {
          void patchUser(user.id, {
            role: user.role === 'super_admin' ? 'user' : 'super_admin',
          });
        });

        const toggleActive = document.createElement('button');
        toggleActive.className = 'btn small';
        toggleActive.type = 'button';
        toggleActive.textContent = user.is_active === 1 ? 'Disable' : 'Enable';
        toggleActive.addEventListener('click', () => {
          void patchUser(user.id, { isActive: user.is_active !== 1 });
        });

        const reset = document.createElement('button');
        reset.className = 'btn small';
        reset.type = 'button';
        reset.textContent = 'Reset password';
        reset.addEventListener('click', () => {
          const next = window.prompt(`New password for "${user.username}" (min 8 characters):`);
          if (next === null) return;
          if (next.length < 8) {
            showError('Password must be at least 8 characters');
            return;
          }
          void patchUser(user.id, { password: next });
        });

        const del = document.createElement('button');
        del.className = 'btn small danger';
        del.type = 'button';
        del.textContent = 'Delete';
        del.disabled = isSelf;
        del.addEventListener('click', () =>
          askDelete({
            label: user.username,
            url: `/api/users/${user.id}`,
            title: 'Delete user?',
            body: 'You are about to permanently delete the account ',
            onDone: loadUsers,
          }),
        );

        actions.append(toggleRole, toggleActive, reset, del);
        tr.append(actions);
        usersBody.append(tr);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not load users');
    }
  }

  async function patchUser(
    id: number,
    body: { role?: Role; isActive?: boolean; password?: string },
  ): Promise<void> {
    clearMessages();
    try {
      await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showOk('User updated');
      await loadUsers();
      // A super admin can demote themselves; refresh so the tabs they no
      // longer have access to disappear straight away.
      await loadMe();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  userForm.addEventListener('submit', (event) => {
    event.preventDefault();
    clearMessages();
    userSave.disabled = true;

    void api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: newUsername.value.trim(),
        password: newPassword.value,
        role: newRole.value,
      }),
    })
      .then(async () => {
        showOk(`Created user "${newUsername.value.trim()}"`);
        userForm.reset();
        await loadUsers();
      })
      .catch((err: unknown) => {
        showError(err instanceof Error ? err.message : 'Could not create user');
      })
      .finally(() => {
        userSave.disabled = false;
      });
  });

  // ---------- audit ----------

  function summarise(entry: AuditEntry): string {
    const before = entry.before_json as Record<string, unknown> | null;
    const after = entry.after_json as Record<string, unknown> | null;

    if (entry.action === 'create' && after) {
      return `${String(after.senderIdType)} / ${String(after.csp)}`;
    }
    if (entry.action === 'delete' && before) {
      return `was ${String(before.senderIdType)} / ${String(before.csp)}`;
    }
    if (entry.action === 'update' && before && after) {
      const changes = (['senderId', 'senderIdType', 'csp'] as const)
        .filter((key) => before[key] !== after[key])
        .map((key) => `${key}: ${String(before[key])} → ${String(after[key])}`);
      return changes.length > 0 ? changes.join(', ') : 'no field changes';
    }
    return '—';
  }

  const auditSize = $<HTMLSelectElement>('audit-size');
  let auditOffset = 0;

  async function loadAudit(): Promise<void> {
    const limit = Number(auditSize.value);
    try {
      const data = await api<{
        entries: AuditEntry[];
        total: number;
        limit: number;
        offset: number;
      }>(`/api/audit?limit=${limit}&offset=${auditOffset}`);

      if (data.entries.length === 0 && data.total > 0 && auditOffset > 0) {
        auditOffset = Math.max(0, (Math.ceil(data.total / limit) - 1) * limit);
        await loadAudit();
        return;
      }

      renderPager('audit', data.total, data.limit, data.offset, 'entries');
      auditBody.replaceChildren();
      auditEmpty.hidden = data.entries.length > 0;

      for (const entry of data.entries) {
        const tr = document.createElement('tr');
        tr.append(
          td(new Date(entry.created_at).toLocaleString(), 'mono'),
          td(entry.actor_username),
          td(entry.action),
          td(entry.sender_id ?? '—', 'mono'),
          td(summarise(entry)),
          td(entry.ip ?? '—', 'mono'),
        );
        auditBody.append(tr);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not load audit log');
    }
  }

  // ---------- tabs, filters, session ----------

  const tabs = {
    senders: $<HTMLButtonElement>('tab-senders'),
    users: $<HTMLButtonElement>('tab-users'),
    audit: $<HTMLButtonElement>('tab-audit'),
  };
  const views = {
    senders: $<HTMLElement>('view-senders'),
    users: $<HTMLElement>('view-users'),
    audit: $<HTMLElement>('view-audit'),
  };
  type TabName = keyof typeof tabs;

  function selectTab(name: TabName): void {
    for (const key of Object.keys(tabs) as TabName[]) {
      tabs[key].setAttribute('aria-selected', String(key === name));
      views[key].hidden = key !== name;
    }
    clearMessages();
    if (name === 'users') void loadUsers();
    if (name === 'audit') void loadAudit();
  }

  $<HTMLButtonElement>('audit-prev').addEventListener('click', () => {
    auditOffset = Math.max(0, auditOffset - Number(auditSize.value));
    void loadAudit();
  });
  $<HTMLButtonElement>('audit-next').addEventListener('click', () => {
    auditOffset += Number(auditSize.value);
    void loadAudit();
  });
  auditSize.addEventListener('change', () => {
    auditOffset = 0;
    void loadAudit();
  });

  tabs.senders.addEventListener('click', () => selectTab('senders'));
  tabs.users.addEventListener('click', () => selectTab('users'));
  tabs.audit.addEventListener('click', () => selectTab('audit'));

  // Any filter change returns to the first page: keeping the old offset would
  // land on an empty page whenever the narrowed result set is shorter.
  let filterTimer: number | undefined;
  const reloadFromFirstPage = (): void => {
    sendersOffset = 0;
    void loadSenders();
  };
  search.addEventListener('input', () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(reloadFromFirstPage, 200);
  });
  filterType.addEventListener('change', reloadFromFirstPage);
  filterCsp.addEventListener('change', reloadFromFirstPage);

  $<HTMLButtonElement>('logout').addEventListener('click', () => {
    void fetch('/logout', { method: 'POST' }).then(() => {
      window.location.href = '/login';
    });
  });

  /**
   * Loads the signed-in user and shows only the tabs their role allows.
   * The server enforces this independently -- /api/users and /api/audit
   * both return 403 for a non-super-admin -- so hiding the tabs is a
   * convenience, not the access control itself.
   */
  async function loadMe(): Promise<void> {
    try {
      const data = await api<{ user: { id: number; username: string; role: Role } }>('/api/me');
      me = data.user;
      $<HTMLSpanElement>('who').textContent =
        `Signed in as ${me.username} (${roleLabel(me.role)})`;

      const isSuper = me.role === 'super_admin';
      tabs.users.hidden = !isSuper;
      tabs.audit.hidden = !isSuper;

      // Demoted while sitting on a privileged tab: fall back to senders.
      if (!isSuper && (!views.users.hidden || !views.audit.hidden)) {
        selectTab('senders');
      }
    } catch {
      /* the api() helper already redirects on 401 */
    }
  }

  void loadMe();
  void loadSenders();
})();

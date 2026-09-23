(() => {
  if (globalThis.__MON_EDT_SCRAPER_V450__) return;
  globalThis.__MON_EDT_SCRAPER_V450__ = true;

  const DATE_RE =
    /\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i;

  const TIME_RANGE_RE =
    /\b(\d{1,2})\s*(?:h|:)\s*(\d{2})\s*[-–—]\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})\b/i;

  const HALF_HOUR_LINE_RE = /^\d{1,2}h\d{2}-?$/i;

  function clean(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }


  const FR_MONTHS = {
    janv: 1, janvier: 1,
    fevr: 2, fevrier: 2,
    mars: 3,
    avr: 4, avril: 4,
    mai: 5,
    juin: 6,
    juil: 7, juillet: 7,
    aout: 8,
    sept: 9, septembre: 9,
    oct: 10, octobre: 10,
    nov: 11, novembre: 11,
    dec: 12, decembre: 12
  };

  function normalizeFrenchMonth(value) {
    return clean(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\./g, "");
  }

  function parseWeekTabFirstDate(text) {
    const value = clean(text);
    const match = value.match(
      /^S\d{1,2}\s+du\s+(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+au\s+(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})$/i
    );
    if (!match) return null;

    const startMonth = FR_MONTHS[normalizeFrenchMonth(match[2])];
    const endMonth = FR_MONTHS[normalizeFrenchMonth(match[4])];
    const endYear = Number(match[5]);
    if (!startMonth || !endMonth || !Number.isInteger(endYear)) return null;

    const startYear = startMonth > endMonth ? endYear - 1 : endYear;
    return `${startYear}-${String(startMonth).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  }

  function multiline(el) {
    return String(el?.innerText || el?.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .split("\n")
      .map(clean)
      .filter(Boolean)
      .join("\n");
  }

  function linesOf(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .split("\n")
      .map(clean)
      .filter(Boolean);
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;

    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 1 &&
      rect.height > 1
    );
  }

  function isoDate(match) {
    return `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(
      match[1]
    ).padStart(2, "0")}`;
  }

  function findDayHeaders() {
    const candidates = [];

    for (const el of document.querySelectorAll("div, span, td, th")) {
      if (!visible(el)) continue;

      const text = clean(multiline(el).replace(/\n+/g, " "));
      if (!text || text.length > 100) continue;

      const match = text.match(DATE_RE);
      if (!match) continue;

      const rect = el.getBoundingClientRect();

      candidates.push({
        date: isoDate(match),
        label: text,
        x: rect.left + rect.width / 2,
        width: rect.width
      });
    }

    const byDate = new Map();

    for (const item of candidates) {
      const old = byDate.get(item.date);

      if (!old || item.width > old.width) {
        byDate.set(item.date, item);
      }
    }

    return [...byDate.values()].sort((a, b) => a.x - b.x);
  }

  function normalizeTime(h, m) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  function nearestDay(headers, rect) {
    if (!headers.length) return null;

    const center = rect.left + rect.width / 2;
    let best = headers[0];
    let distance = Math.abs(best.x - center);

    for (const header of headers.slice(1)) {
      const current = Math.abs(header.x - center);

      if (current < distance) {
        best = header;
        distance = current;
      }
    }

    return best;
  }

  function isTimeScale(raw, rect) {
    const lines = linesOf(raw);
    const clocks = lines.filter((line) => HALF_HOUR_LINE_RE.test(line));

    return (
      clocks.length >= 8 ||
      (rect.width < 80 && rect.height > 250) ||
      (lines.length >= 12 && clocks.length / lines.length > 0.6)
    );
  }

  function isLeafWithTime(el) {
    const raw = multiline(el);

    if (!TIME_RANGE_RE.test(raw)) return false;

    for (const child of el.children) {
      if (TIME_RANGE_RE.test(multiline(child))) return false;
    }

    return true;
  }

  function dedupe(values) {
    const seen = new Set();
    const out = [];

    for (const value of values) {
      const text = clean(value);
      const key = text.toLocaleLowerCase("fr");

      if (!text || seen.has(key)) continue;

      seen.add(key);
      out.push(text);
    }

    return out;
  }

  function inferFields(details) {
    const groupLine =
      details.find((line) => /^(CM|TD|TP|TDP|CTD)\b.*\bGR\d+/i.test(line)) ||
      null;

    const building =
      details.find((line) => /^BATIMENT\b/i.test(line)) || null;

    const room =
      details.find((line) =>
        /^(?:[A-Z]\s*\d+(?:\.\d+)?|AMP(?:HI)?\b.*|SALLE\b.*)/i.test(line)
      ) || null;

    const teacherCandidates = details.filter((line) => {
      if (line === groupLine || line === building || line === room) return false;
      if (/^(CM|TD|TP|TDP|CTD)\b/i.test(line)) return false;

      return /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}/.test(line);
    });

    return {
      groupLine,
      room,
      building,
      teacherCandidates
    };
  }

  function parseEvent(el, headers) {
    if (!visible(el)) return null;

    const rect = el.getBoundingClientRect();
    const rawText = multiline(el);

    if (isTimeScale(rawText, rect)) return null;

    const time = rawText.match(TIME_RANGE_RE);
    if (!time) return null;

    const day = nearestDay(headers, rect);
    if (!day) return null;

    const logical = dedupe(
      linesOf(rawText).filter(
        (line) => !TIME_RANGE_RE.test(line) && !DATE_RE.test(line)
      )
    );

    const title = logical.shift() || "Cours";
    const details = logical;
    const inferred = inferFields(details);

    return {
      date: day.date,
      dayLabel: day.label,
      startTime: normalizeTime(time[1], time[2]),
      endTime: normalizeTime(time[3], time[4]),
      title,
      details,
      ...inferred,
      rawText,
      source: "ADE"
    };
  }

  function uniqueEvents(events) {
    const seen = new Set();
    const out = [];

    for (const event of events) {
      const key = [
        event.date,
        event.startTime,
        event.endTime,
        event.title,
        event.details.join("¦")
      ].join("|");

      if (seen.has(key)) continue;

      seen.add(key);
      out.push(event);
    }

    return out;
  }

  function planningTreeSnapshot() {
    const tree = globalThis.PlanilimAdeTree;
    if (!tree?.snapshotDocument) {
      return {
        ok: false,
        code: "ADE_TREE_HELPER_MISSING",
        rowCount: 0,
        selected: null,
        rows: []
      };
    }
    return tree.snapshotDocument(document);
  }

  async function scanPlanningTree(options = {}) {
    const tree = globalThis.PlanilimAdeTree;
    const scroller = [...document.querySelectorAll(".x-grid3-scroller")]
      .find((element) => element.querySelector(".x-tree3-node"));
    if (!tree?.rawRowsFromDocument || !scroller) return planningTreeSnapshot();

    const scopePath = String(options.scopePath || "").trim();
    const stopAfterScope = Boolean(scopePath && options.stopAfterScope !== false);
    const originalTop = scroller.scrollTop;
    // ADE/GXT virtualise fortement cet arbre. On utilise un balayage avec
    // recouvrement et une lecture explicite du bas de la grille afin de ne pas
    // perdre le dernier semestre d'une branche quand il tombe entre deux
    // fenêtres de rendu virtuel.
    const step = Math.max(180, Math.floor(scroller.clientHeight * 0.62));
    const byResource = new Map();

    const collectVisible = () => {
      for (const raw of tree.rawRowsFromDocument(document)) {
        const key = raw.resourceId == null ? raw.nodeId : String(raw.resourceId);
        if (!byResource.has(key)) byResource.set(key, raw);
        else if (raw.selected) byResource.set(key, raw);
      }
    };

    const leftRequestedScope = () => {
      if (!stopAfterScope) return false;
      const normalized = tree.normalizeRows([...byResource.values()]);
      const scopeIndex = normalized.findIndex((row) => row.path === scopePath);
      if (scopeIndex < 0) return false;
      const scopeLevel = Number(normalized[scopeIndex].level);
      return normalized.slice(scopeIndex + 1).some((row) =>
        Number(row.level) <= scopeLevel &&
        !tree.pathIsWithinScope(row.pathParts || row.path, scopePath)
      );
    };

    try {
      let top = 0;
      let lastMaxTop = -1;
      let guard = 0;
      while (guard++ < 600) {
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const targetTop = Math.min(top, maxTop);
        scroller.scrollTop = targetTop;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 55));
        collectVisible();

        if (leftRequestedScope()) break;
        if (targetTop >= maxTop) {
          // Une dernière lecture plus lente est importante : ExtJS peut
          // réutiliser les mêmes lignes DOM quelques millisecondes après le
          // scroll et le tout dernier enfant n'est alors visible qu'au tick
          // suivant.
          await new Promise((resolve) => setTimeout(resolve, 90));
          collectVisible();
          break;
        }
        if (maxTop === lastMaxTop && top > maxTop + step) break;
        lastMaxTop = maxTop;
        top = targetTop + step;
      }

      // Lecture de sécurité du bas de l'arbre, même si la sortie a été causée
      // par la détection de la branche suivante.
      const finalTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = finalTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 90));
      collectVisible();
    } finally {
      scroller.scrollTop = originalTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    let rows = tree.normalizeRows([...byResource.values()]);
    if (scopePath) {
      rows = rows.filter((row) => tree.pathIsWithinScope(row.pathParts || row.path, scopePath));
    }
    const liveSelected = planningTreeSnapshot().selected;
    const selected = liveSelected && (!scopePath || tree.pathIsWithinScope(liveSelected.pathParts || liveSelected.path, scopePath))
      ? liveSelected
      : rows.find((row) => row.selected) || null;
    return {
      ok: rows.length > 0,
      code: rows.length > 0 ? "ADE_TREE_SCAN_READY" : "ADE_TREE_NOT_FOUND",
      rowCount: rows.length,
      selected,
      rows
    };
  }

  function selectedPlanningResource() {
    return planningTreeSnapshot().selected || null;
  }

  function selectedPlanningLabel() {
    const selected = selectedPlanningResource();
    if (selected?.label) return selected.label;

    const selectors = [
      ".x-tree3-node-selected .x-tree3-node-text",
      ".x-tree3-node-selected .x-tree3-node-text span",
      ".x-tree3-node-selected",
      ".x-tree-node-selected",
      ".x-grid3-row-selected .x-grid3-cell-inner",
      ".x-view-selected",
      "[aria-selected='true']"
    ];

    const candidates = [];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const text = clean(String(el.innerText || el.textContent || "").replace(/\n+/g, " "));
        if (!text || text.length > 90) continue;
        if (/^S\d{1,2}\s+du\s+/i.test(text)) continue;
        if (DATE_RE.test(text)) continue;
        if (TIME_RANGE_RE.test(text)) continue;
        candidates.push(text);
      }
    }

    const unique = dedupe(candidates);
    if (!unique.length) return null;

    // Les libellés de ressource courts (ex. « L3 Maths ») sont préférés
    // aux conteneurs qui concatènent plusieurs éléments de l'arbre.
    unique.sort((a, b) => {
      const aScore = (/^L\d\b/i.test(a) ? 100 : 0) - a.length;
      const bScore = (/^L\d\b/i.test(b) ? 100 : 0) - b.length;
      return bScore - aScore;
    });

    return unique[0] || null;
  }

  function dispatchPlanningClick(element, clickCount = 1) {
    if (!element) return;
    const view = element.ownerDocument?.defaultView || window;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      detail: clickCount,
      button: 0,
      buttons: 1
    };

    try {
      element.dispatchEvent(new PointerEvent("pointerdown", common));
    } catch {}
    element.dispatchEvent(new MouseEvent("mousedown", common));
    try {
      element.dispatchEvent(new PointerEvent("pointerup", { ...common, buttons: 0 }));
    } catch {}
    element.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    if (clickCount >= 2) {
      element.dispatchEvent(new MouseEvent("dblclick", { ...common, buttons: 0, detail: 2 }));
    }
  }

  function expandPlanningRow(row) {
    if (!row) return false;
    const joint = row.querySelector(".x-tree3-node-joint");
    if (joint) {
      dispatchPlanningClick(joint, 1);
      return true;
    }

    const text = row.querySelector(".x-tree3-node-text");
    if (!text) return false;
    dispatchPlanningClick(text, 2);
    return true;
  }

  function domRowForResource(resource) {
    // ExtJS virtualise l'arbre et recycle ses lignes. Pour le parcours de
    // l'arborescence, le nodeId exact reste toutefois la meilleure ancre tant
    // qu'il est encore présent dans le DOM. On vérifie simplement que son
    // resourceId correspond toujours avant de l'utiliser.
    const targetId = Number(resource?.resourceId);
    const targetNodeId = String(resource?.nodeId || "");

    if (targetNodeId) {
      const byNode = [...document.querySelectorAll(".x-grid3-row")].find((row) =>
        row.querySelector(".x-tree3-node[id^='Direct Planning Tree_']")?.id === targetNodeId
      );
      if (byNode) {
        const liveNode = byNode.querySelector(".x-tree3-node[id^='Direct Planning Tree_']");
        const liveId = globalThis.PlanilimAdeTree?.parseResourceId(liveNode?.id);
        if (!Number.isFinite(targetId) || Number(liveId) === targetId) return byNode;
      }
    }

    // Fallback pour une ligne fraîchement rerendue : on retrouve la ligne via
    // le resourceId stable. Cette recherche n'est jamais utilisée seule pour
    // cliquer une cible sans validation supplémentaire dans selectPlanningResource.
    if (Number.isFinite(targetId)) {
      return [...document.querySelectorAll(".x-grid3-row")].find((row) => {
        const node = row.querySelector(".x-tree3-node[id^='Direct Planning Tree_']");
        return Number(globalThis.PlanilimAdeTree?.parseResourceId(node?.id)) === targetId;
      }) || null;
    }

    return null;
  }

  function planningResourceMatchesTarget(resource, target) {
    if (!resource) return false;
    const expectedId = Number(target?.resourceId);
    if (Number.isFinite(expectedId)) {
      return Number(resource?.resourceId) === expectedId;
    }

    // Quand aucun resourceId n'est disponible (notamment certains ancêtres de
    // l'arbre), on peut se rabattre sur le chemin. On ne compare plus le chemin
    // lorsqu'un resourceId existe : dans la grille virtualisée, les ancêtres
    // hors écran peuvent rendre le chemin reconstruit temporairement incomplet.
    const expectedPath = clean(target?.path);
    const actualPath = clean(resource?.path);
    if (expectedPath && actualPath) return expectedPath === actualPath;
    return true;
  }

  function freshPlanningTarget(target) {
    return {
      resourceId: target?.resourceId == null ? null : Number(target.resourceId),
      label: clean(target?.label),
      path: clean(target?.path),
      // nodeId volontairement omis : il peut être issu d'un ancien rendu ExtJS.
      nodeId: ""
    };
  }

  function planningScroller() {
    return [...document.querySelectorAll(".x-grid3-scroller")]
      .find((element) => element.querySelector(".x-tree3-node")) || null;
  }

  async function revealPlanningPath(target) {
    const parts = String(target?.path || "")
      .split(">")
      .map(clean)
      .filter(Boolean);
    const scroller = planningScroller();
    if (!scroller || parts.length < 2) return { resource: null, row: null };

    const samePath = (row, depth) => {
      const rowParts = Array.isArray(row?.pathParts) ? row.pathParts.map(clean) : [];
      return Number(row?.level) === depth + 1 &&
        rowParts.length >= depth + 1 &&
        parts.slice(0, depth + 1).every((part, index) => rowParts[index] === part);
    };

    const findPart = async (depth) => {
      const step = Math.max(280, Math.floor(scroller.clientHeight * 0.88));
      for (let top = 0; top <= scroller.scrollHeight; top += step) {
        scroller.scrollTop = Math.min(top, scroller.scrollHeight);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        const snapshot = planningTreeSnapshot();
        const resource = snapshot.rows.find((row) => samePath(row, depth));
        const domRow = resource ? domRowForResource(resource) : null;
        if (resource && domRow) return { resource, row: domRow };
      }
      return { resource: null, row: null };
    };

    let current = { resource: null, row: null };
    for (let depth = 0; depth < parts.length; depth += 1) {
      current = await findPart(depth);
      if (!current.resource || !current.row) return { resource: null, row: null };
      if (depth >= parts.length - 1) return current;
      if (current.resource.expanded === true) continue;

      try { current.row.scrollIntoView({ block: "nearest" }); } catch {}
      if (!expandPlanningRow(current.row)) return { resource: null, row: null };
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    return current;
  }

  async function revealPlanningResource(target, options = {}) {
    const lookupTarget = options.forceFresh === true ? freshPlanningTarget(target) : target;
    let snapshot = planningTreeSnapshot();
    let resource = globalThis.PlanilimAdeTree?.findRow(snapshot.rows, lookupTarget);
    let row = resource ? domRowForResource(resource) : null;
    if (resource && row && planningResourceMatchesTarget(resource, target)) return { resource, row };

    // Une ligne trouvée via un nodeId ancien ne doit jamais être cliquée.
    resource = null;
    row = null;

    const scroller = planningScroller();
    if (!scroller) return { resource: null, row: null };

    // Après une mauvaise sélection, on repart volontairement du chemin complet
    // avant de retenter la recherche rapide par resourceId. Cela force ExtJS à
    // reconstruire une instance fraîche de la ligne au lieu de réutiliser celle
    // qui vient d'être recyclée.
    if (options.forceFresh === true && target?.path) {
      const byPath = await revealPlanningPath(freshPlanningTarget(target));
      if (byPath.resource && byPath.row && planningResourceMatchesTarget(byPath.resource, target)) {
        return byPath;
      }
    }

    // Pendant la collecte, les branches utiles sont déjà ouvertes. Pour une
    // feuille connue par son resourceId, il est beaucoup plus rapide de
    // parcourir une seule fois la grille virtualisée que de reconstruire tout
    // son chemin et de rescanner l'arbre à chaque niveau. On commence autour de
    // la position courante : les EDT sont traités dans l'ordre de l'arbre, donc
    // le suivant est généralement à quelques lignes seulement.
    if (Number.isFinite(Number(target?.resourceId))) {
      const step = Math.max(220, Math.floor(scroller.clientHeight * 0.78));
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const startTop = Math.max(0, Math.min(maxTop, scroller.scrollTop));
      const positions = [];

      for (let top = startTop; top <= maxTop; top += step) positions.push(Math.min(top, maxTop));
      for (let top = 0; top < startTop; top += step) positions.push(Math.min(top, maxTop));

      let lastTop = -1;
      for (const top of positions) {
        if (top === lastTop) continue;
        lastTop = top;
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 28));
        snapshot = planningTreeSnapshot();
        resource = globalThis.PlanilimAdeTree?.findRow(snapshot.rows, lookupTarget);
        row = resource ? domRowForResource(resource) : null;
        if (resource && row && planningResourceMatchesTarget(resource, target)) return { resource, row };
      }

      // ExtJS peut rendre les toutes dernières lignes un tick plus tard.
      scroller.scrollTop = maxTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 70));
      snapshot = planningTreeSnapshot();
      resource = globalThis.PlanilimAdeTree?.findRow(snapshot.rows, lookupTarget);
      row = resource ? domRowForResource(resource) : null;
      if (resource && row && planningResourceMatchesTarget(resource, target)) return { resource, row };
    }

    // Fallback seulement : utile si une branche a été repliée entre l'analyse
    // et la synchronisation. Ce chemin lent ne doit plus être le cas normal.
    if (target?.path) {
      const revealed = await revealPlanningPath(target);
      if (revealed.resource && revealed.row && planningResourceMatchesTarget(revealed.resource, target)) return revealed;
    }

    return { resource: null, row: null };
  }

  async function waitForSelectedResource(resourceId, timeoutMs = 6500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const selected = selectedPlanningResource();
      if (selected?.resourceId === resourceId) return selected;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return null;
  }

  async function selectPlanningResource(target, options = {}) {
    const expectedResourceId = Number(target?.resourceId);
    const observedSelectedResourceIds = new Set();
    const maxAttempts = Math.max(1, Math.min(4, Number(options.maxAttempts) || 3));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Chaque retry repart d'une recherche neuve dans la grille virtualisée.
      // On ne conserve jamais la ligne DOM trouvée lors de la tentative précédente.
      const revealed = await revealPlanningResource(target, {
        forceFresh: options.forceFresh === true || attempt > 0
      });
      const resource = revealed.resource;
      const row = revealed.row;

      if (!resource || !row || !planningResourceMatchesTarget(resource, target)) {
        if (attempt + 1 < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 180 + attempt * 120));
          continue;
        }
        return {
          ok: false,
          code: "ADE_RESOURCE_NOT_VISIBLE",
          target: target || null,
          expectedResourceId: Number.isFinite(expectedResourceId) ? expectedResourceId : null,
          observedSelectedResourceIds: [...observedSelectedResourceIds],
          selectionAttempts: attempt + 1,
          tree: planningTreeSnapshot()
        };
      }

      const node = row.querySelector?.(".x-tree3-node[id^='Direct Planning Tree_']");
      const rowResourceId = globalThis.PlanilimAdeTree?.parseResourceId(node?.id);
      if (Number.isFinite(expectedResourceId) && Number(rowResourceId) !== expectedResourceId) {
        // La ligne a été recyclée entre le snapshot et le clic : on la jette.
        if (Number.isFinite(Number(rowResourceId))) observedSelectedResourceIds.add(Number(rowResourceId));
        await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 100));
        continue;
      }

      const alreadySelected = selectedPlanningResource();
      if (Number(alreadySelected?.resourceId) === expectedResourceId) {
        return {
          ok: true,
          code: "ADE_RESOURCE_ALREADY_SELECTED",
          resource: { ...resource, ...alreadySelected, path: target?.path || resource.path },
          selectionAttempts: attempt + 1,
          observedSelectedResourceIds: [...observedSelectedResourceIds]
        };
      }

      const clickTarget = row.querySelector?.(".x-tree3-node-text") || row;
      if (!clickTarget) {
        if (attempt + 1 < maxAttempts) continue;
        return {
          ok: false,
          code: "ADE_RESOURCE_ROW_MISSING",
          resource,
          expectedResourceId,
          selectionAttempts: attempt + 1,
          observedSelectedResourceIds: [...observedSelectedResourceIds]
        };
      }

      try { row.scrollIntoView({ block: "nearest" }); } catch {}
      dispatchPlanningClick(clickTarget, 1);

      const selected = await waitForSelectedResource(expectedResourceId, attempt === 0 ? 4200 : 5600);
      if (selected && Number(selected.resourceId) === expectedResourceId) {
        return {
          ok: true,
          code: attempt > 0 ? "ADE_RESOURCE_SELECTED_AFTER_FRESH_SEARCH" : "ADE_RESOURCE_SELECTED",
          resource: { ...resource, ...selected, path: target?.path || resource.path },
          selectionAttempts: attempt + 1,
          observedSelectedResourceIds: [...observedSelectedResourceIds]
        };
      }

      const wrongSelected = selectedPlanningResource();
      const wrongId = Number(wrongSelected?.resourceId);
      if (Number.isFinite(wrongId) && wrongId !== expectedResourceId) observedSelectedResourceIds.add(wrongId);

      // Laisser ExtJS terminer son rerendu, puis rescanner depuis zéro.
      await new Promise((resolve) => setTimeout(resolve, 220 + attempt * 160));
    }

    return {
      ok: false,
      code: "ADE_RESOURCE_SELECTION_TIMEOUT",
      expectedResourceId: Number.isFinite(expectedResourceId) ? expectedResourceId : null,
      observedSelectedResourceIds: [...observedSelectedResourceIds],
      selectionAttempts: maxAttempts
    };
  }

  async function togglePlanningBranch(target) {
    const revealed = await revealPlanningResource(target);
    const resource = revealed.resource;
    if (!resource) return { ok: false, code: "ADE_RESOURCE_NOT_VISIBLE", target };

    const row = revealed.row;
    if (!row) return { ok: false, code: "ADE_RESOURCE_ROW_MISSING", resource };

    const wasExpanded = resource.expanded === true;
    try { row.scrollIntoView({ block: "nearest" }); } catch {}
    if (!expandPlanningRow(row)) {
      return { ok: false, code: "ADE_BRANCH_TOGGLE_MISSING", resource };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    const nextResource = globalThis.PlanilimAdeTree?.findRow(
      planningTreeSnapshot().rows,
      target
    );
    const expanded = nextResource?.expanded === true;
    return {
      ok: wasExpanded !== expanded || expanded,
      code: expanded ? "ADE_BRANCH_EXPANDED" : "ADE_BRANCH_NOT_EXPANDED",
      resource: nextResource || resource,
      expanded
    };
  }

  function isPlanningTerminalLabel(label) {
    const value = String(label || "").trim();
    return /^semestre\s+\d+$/i.test(value) || /^(?:AN|ANNÉE|ANNEE)$/i.test(value);
  }

  function rowIsAtOrBelowPlanningTerminal(row, scopePath) {
    const parts = Array.isArray(row?.pathParts)
      ? row.pathParts.map((part) => String(part || "").trim()).filter(Boolean)
      : String(row?.path || "").split(">").map((part) => part.trim()).filter(Boolean);
    const scopeParts = String(scopePath || "").split(">").map((part) => part.trim()).filter(Boolean);
    const relative = parts.slice(scopeParts.length);
    return relative.some((part) => isPlanningTerminalLabel(part));
  }

  async function expandAllPlanningBranches(options = {}) {
    const tree = globalThis.PlanilimAdeTree;
    if (!tree?.pathTouchesScope) {
      return {
        ok: false,
        code: "ADE_TREE_HELPER_MISSING",
        message: "Le lecteur de l'arborescence ADE n'est pas disponible."
      };
    }
    const maxBranches = Math.max(1, Math.min(300, Number(options.maxBranches) || 200));
    const maxDurationMs = Math.max(5000, Math.min(60000, Number(options.maxDurationMs) || 45000));
    // maxDepth est une profondeur RELATIVE au dossier de périmètre.
    // Avec le périmètre « Groupes Etudiants > Faculté des Sciences et Techniques »
    // situé généralement au niveau 2, maxDepth=4 sert uniquement de garde-fou ; l’arrêt normal se fait
    // dès qu’un nœud Semestre N / AN est rencontré sans laisser le collecteur descendre indéfiniment.
    const maxDepth = Math.max(1, Math.min(4, Number(options.maxDepth) || 4));
    const scopeRoot = String(options.scopeRoot || "Groupes Etudiants").trim();
    const scopePath = String(options.scopePath || "Groupes Etudiants > Faculté des Sciences et Techniques").trim();
    const rowTouchesScope = (row) => tree.pathTouchesScope(
      row.pathParts || row.path,
      scopePath
    );
    const startedAt = Date.now();
    let expandedCount = 0;
    const failedBranches = new Set();
    const branchKey = (row) => String(
      row?.nodeId || row?.resourceId || row?.path || row?.label || ""
    );

    // On ouvre d'abord uniquement le chemin autorisé. Aucun autre dossier de
    // Groupes Etudiants n'est développé pendant cette phase.
    const scopeTarget = await revealPlanningPath({ path: scopePath });
    if (!scopeTarget?.resource || !scopeTarget?.row) {
      return {
        ok: false,
        code: "ADE_SCOPE_NOT_FOUND",
        message: `Le dossier ${scopePath} est introuvable dans ADE.`,
        scopeRoot,
        scopePath,
        rows: []
      };
    }
    const scopeLevel = Number(scopeTarget.resource.level) || 1;
    const maxAbsoluteLevel = scopeLevel + maxDepth;

    if (scopeTarget.resource.expanded !== true) {
      try { scopeTarget.row.scrollIntoView({ block: "nearest" }); } catch {}
      if (!expandPlanningRow(scopeTarget.row)) {
        return {
          ok: false,
          code: "ADE_SCOPE_NOT_EXPANDABLE",
          message: `Le dossier ${scopePath} ne peut pas être ouvert.`,
          scopeRoot,
          scopePath,
          rows: []
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      expandedCount += 1;
    }

    let lastSnapshot = await scanPlanningTree({ scopePath, stopAfterScope: true });

    while (expandedCount < maxBranches && Date.now() - startedAt < maxDurationMs) {
      const branch = lastSnapshot.rows.find((row) =>
        (row.branchToggle === true || row.expanded === false) &&
        row.expanded !== true &&
        !failedBranches.has(branchKey(row)) &&
        Number(row.level) < maxAbsoluteLevel &&
        rowTouchesScope(row) &&
        !rowIsAtOrBelowPlanningTerminal(row, scopePath)
      );
      if (!branch) break;

      const result = await togglePlanningBranch(branch);
      if (!result?.expanded) {
        // Une branche qui ne s'ouvre pas est traitée comme un planning final
        // pour éviter de boucler indéfiniment sur un serveur ADE lent.
        failedBranches.add(branchKey(branch));
      } else {
        expandedCount += 1;
      }
      lastSnapshot = await scanPlanningTree({ scopePath, stopAfterScope: true });
    }

    const pendingBranchCount = lastSnapshot.rows.filter((row) =>
      (row.branchToggle === true || row.expanded === false) &&
      row.expanded !== true &&
      !failedBranches.has(branchKey(row)) &&
      Number(row.level) < maxAbsoluteLevel &&
      rowTouchesScope(row) &&
      !rowIsAtOrBelowPlanningTerminal(row, scopePath)
    ).length;
    const timeBudgetReached = Date.now() - startedAt >= maxDurationMs;

    return {
      ...lastSnapshot,
      ok: true,
      code: "ADE_TREE_EXPANDED_AND_SCANNED",
      expandedCount,
      failedBranchCount: failedBranches.size,
      scopeRoot,
      scopePath,
      maxDepth,
      scopeLevel,
      maxAbsoluteLevel,
      pendingBranchCount,
      timeBudgetReached,
      truncated: pendingBranchCount > 0 || expandedCount >= maxBranches || timeBudgetReached
    };
  }


  const COLLECTOR_PIPELINE_STATE_KEY = "__planilimCollectorPipelineState";

  function collectorPipelineState() {
    return globalThis[COLLECTOR_PIPELINE_STATE_KEY] || null;
  }

  function collectorPipelineSetState(state) {
    globalThis[COLLECTOR_PIPELINE_STATE_KEY] = state;
    return state;
  }

  function collectorPipelineResetState() {
    try { delete globalThis[COLLECTOR_PIPELINE_STATE_KEY]; } catch {
      globalThis[COLLECTOR_PIPELINE_STATE_KEY] = null;
    }
    return { ok: true, code: "ADE_PIPELINE_RESET" };
  }

  function collectorPipelineRowKey(raw) {
    return String(raw?.nodeId || raw?.resourceId || `${raw?.level || 0}:${raw?.label || ""}`);
  }

  async function waitForPlanningBranchOpen(target, previousScrollHeight, timeoutMs = 1200) {
    const started = Date.now();
    const scroller = planningScroller();
    while (Date.now() - started < timeoutMs) {
      const rawRows = globalThis.PlanilimAdeTree?.rawRowsFromDocument?.(document) || [];
      const match = rawRows.find((raw) =>
        (target?.nodeId && raw.nodeId === target.nodeId) ||
        (target?.resourceId != null && Number(raw.resourceId) === Number(target.resourceId))
      );
      if (match?.expanded === true) return true;
      if (scroller && scroller.scrollHeight > Number(previousScrollHeight || 0) + 2) return true;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return false;
  }

  async function initCollectorPipeline(options = {}) {
    const tree = globalThis.PlanilimAdeTree;
    const scopePath = String(options.scopePath || "Groupes Etudiants > Faculté des Sciences et Techniques").trim();
    const targetKind = String(options.targetKind || "program").toLowerCase() === "room" ? "room" : "program";
    const maxDepth = Math.max(1, Math.min(4, Number(options.maxDepth) || 4));
    const scroller = planningScroller();
    if (!tree?.rawRowsFromDocument || !scroller) {
      return { ok: false, code: "ADE_TREE_NOT_FOUND" };
    }

    const scopeTarget = await revealPlanningPath({ path: scopePath });
    if (!scopeTarget?.resource || !scopeTarget?.row) {
      return { ok: false, code: "ADE_SCOPE_NOT_FOUND", scopePath };
    }

    if (scopeTarget.resource.expanded !== true) {
      try { scopeTarget.row.scrollIntoView({ block: "nearest" }); } catch {}
      const beforeHeight = scroller.scrollHeight;
      if (!expandPlanningRow(scopeTarget.row)) {
        return { ok: false, code: "ADE_SCOPE_NOT_EXPANDABLE", scopePath };
      }
      await waitForPlanningBranchOpen(scopeTarget.resource, beforeHeight, 1400);
    }

    const scopeParts = scopePath.split(">").map(clean).filter(Boolean);
    const scopeLevel = Number(scopeTarget.resource.level) || scopeParts.length;
    const levelLabels = [];
    for (let index = 0; index < scopeParts.length; index += 1) {
      levelLabels[index] = scopeParts[index];
    }

    const state = {
      scopePath,
      scopeParts,
      scopeLevel,
      targetKind,
      maxDepth,
      maxAbsoluteLevel: scopeLevel + maxDepth,
      levelLabels,
      terminalIds: [],
      terminalSet: new Set(),
      branchAttempts: {},
      expandedSet: new Set(),
      scrollTop: Math.max(0, scroller.scrollTop),
      bottomStablePasses: 0,
      sweepIndex: 0,
      sweepStartDiscovered: 0,
      sweepStartExpanded: 0,
      done: false,
      discoveredCount: 0,
      expandedCount: 0,
      startedAt: Date.now()
    };
    collectorPipelineSetState(state);
    return { ok: true, code: "ADE_PIPELINE_READY", scopePath, scopeLevel, targetKind, maxDepth };
  }

  function collectorPipelinePathFromRaw(state, raw) {
    const level = Number(raw?.level);
    const label = clean(raw?.label);
    if (!Number.isFinite(level) || level < 1 || !label) return null;
    state.levelLabels.length = Math.max(state.levelLabels.length, level);
    state.levelLabels[level - 1] = label;
    state.levelLabels.length = level;
    const parts = state.levelLabels.slice(0, level).filter(Boolean);
    return {
      label,
      level,
      nodeId: String(raw?.nodeId || ""),
      resourceId: raw?.resourceId == null ? null : Number(raw.resourceId),
      selected: raw?.selected === true,
      expanded: raw?.expanded,
      branchToggle: raw?.branchToggle === true,
      pathParts: parts,
      path: parts.join(" > ")
    };
  }

  async function selectVisiblePlanningRow(resource, row) {
    if (!resource || !row) return { ok: false, code: "ADE_RESOURCE_ROW_MISSING" };
    if (resource.selected) {
      return { ok: true, code: "ADE_RESOURCE_ALREADY_SELECTED", resource, selectedAt: Date.now() };
    }

    const selectedAt = Date.now();
    let lastRow = row;

    // Un clic ExtJS peut être perdu pendant un rerendu de l'arbre. On garde le
    // chemin rapide, puis on ne retente que si ADE n'a réellement pas confirmé
    // la sélection. Les succès ne paient donc pratiquement aucun délai en plus.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const alreadySelected = planningTreeSnapshot()?.selected;
      if (Number(alreadySelected?.resourceId) === Number(resource.resourceId)) {
        return {
          ok: true,
          code: "ADE_RESOURCE_SELECTED",
          resource: { ...resource, ...alreadySelected, path: resource.path, pathParts: resource.pathParts },
          selectedAt
        };
      }

      const currentRow = domRowForResource(resource) || lastRow;
      const clickTarget = currentRow?.querySelector?.(".x-tree3-node-text") || currentRow;
      if (!clickTarget) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 160));
          continue;
        }
        return { ok: false, code: "ADE_RESOURCE_ROW_MISSING", resource, selectedAt };
      }

      lastRow = currentRow;
      try { currentRow.scrollIntoView({ block: "nearest" }); } catch {}
      dispatchPlanningClick(clickTarget, 1);

      const selected = await waitForSelectedResource(resource.resourceId, attempt === 0 ? 3200 : 4600);
      if (selected) {
        return {
          ok: true,
          code: "ADE_RESOURCE_SELECTED",
          resource: { ...resource, ...selected, path: resource.path, pathParts: resource.pathParts },
          selectedAt
        };
      }

      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 180 + attempt * 120));
      }
    }

    return { ok: false, code: "ADE_RESOURCE_SELECTION_TIMEOUT", resource, selectedAt };
  }

  function collectorPipelineIsTarget(state, resource) {
    if (!resource || resource.resourceId == null) return false;
    if (state?.targetKind === "room") {
      const relativeDepth = Number(resource.level) - Number(state.scopeLevel);
      const label = String(resource.label || "").trim();
      // Le périmètre salle est fixé sur « LIMOGES La Borie FST ».
      // Les bâtiments restent des branches ; toute feuille ressource située
      // sous ce périmètre est une salle, y compris une salle directement
      // rattachée au site sans nœud « Bâtiment » intermédiaire.
      return relativeDepth >= 1 && resource.branchToggle !== true && !/^B(?:A|Â)TIMENT\b/i.test(label);
    }
    return isPlanningTerminalLabel(resource.label);
  }

  async function collectorPipelineNext(options = {}) {
    let state = collectorPipelineState();
    if (!state || options.reset === true) {
      const initialized = await initCollectorPipeline(options);
      if (!initialized?.ok) return initialized;
      state = collectorPipelineState();
    }
    if (state.done) {
      return { ok: true, code: "ADE_PIPELINE_DONE", done: true, discoveredCount: state.discoveredCount, expandedCount: state.expandedCount };
    }

    const tree = globalThis.PlanilimAdeTree;
    const scroller = planningScroller();
    if (!tree?.rawRowsFromDocument || !scroller) return { ok: false, code: "ADE_TREE_NOT_FOUND" };

    // La synchronisation annuelle peut faire bouger le rendu ExtJS. On reprend
    // donc le parcours à la position mémorisée avant de chercher l'EDT suivant.
    const maxResumeTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const resumeTop = Math.max(0, Math.min(maxResumeTop, Number(state.scrollTop || 0)));
    if (Math.abs(scroller.scrollTop - resumeTop) > 2) {
      scroller.scrollTop = resumeTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 70));
    }

    const maxActions = Math.max(40, Math.min(1200, Number(options.maxActions) || 500));
    let actions = 0;

    while (actions++ < maxActions) {
      const rawRows = tree.rawRowsFromDocument(document);
      let expandedSomething = false;

      for (const raw of rawRows) {
        const resource = collectorPipelinePathFromRaw(state, raw);
        if (!resource) continue;
        const parts = resource.pathParts || [];
        const withinScope = parts.length >= state.scopeParts.length &&
          state.scopeParts.every((part, index) => parts[index] === part);
        const touchesScope = parts.length > 0 &&
          parts.slice(0, Math.min(parts.length, state.scopeParts.length))
            .every((part, index) => part === state.scopeParts[index]);

        if (!touchesScope) {
          // Une ligne hors périmètre ne signifie pas que la FST est terminée :
          // l'arbre ADE est virtualisé et peut réafficher des parents voisins
          // après la sélection d'un planning. La fin est validée uniquement par
          // les passages complets et stables effectués plus bas.
          continue;
        }
        if (!withinScope) continue;

        if (collectorPipelineIsTarget(state, resource)) {
          const terminalKey = String(resource.resourceId);
          if (state.terminalSet.has(terminalKey)) continue;
          state.terminalSet.add(terminalKey);
          state.terminalIds.push(terminalKey);
          state.discoveredCount += 1;
          state.scrollTop = scroller.scrollTop;
          state.bottomStablePasses = 0;

          // v4.10.0 : le coordinateur ne touche jamais au planning courant.
          // Il se contente de lire l'arbre complet et de mémoriser les cibles.
          // Les pages workers seront ouvertes seulement une fois cette lecture
          // terminée et feront elles-mêmes leur sélection par path + resourceId.
          if (options.selectTargets === false) {
            return {
              ok: true,
              code: "ADE_PIPELINE_TARGET_DISCOVERED",
              done: false,
              target: resource,
              selection: null,
              discoveredCount: state.discoveredCount,
              expandedCount: state.expandedCount
            };
          }

          const row = domRowForResource(resource);
          const selected = await selectVisiblePlanningRow(resource, row);
          if (!selected?.ok) {
            return {
              ok: true,
              code: "ADE_PIPELINE_TARGET_SELECTION_FAILED",
              done: false,
              target: resource,
              selection: selected,
              discoveredCount: state.discoveredCount,
              expandedCount: state.expandedCount
            };
          }
          return {
            ok: true,
            code: "ADE_PIPELINE_TARGET_SELECTED",
            done: false,
            target: selected.resource || resource,
            selectedAt: selected.selectedAt || Date.now(),
            discoveredCount: state.discoveredCount,
            expandedCount: state.expandedCount
          };
        }

        const relativeDepth = resource.level - state.scopeLevel;
        const canExpand =
          resource.branchToggle === true &&
          resource.expanded !== true &&
          relativeDepth >= 0 &&
          relativeDepth < state.maxDepth;
        if (!canExpand) continue;

        const key = collectorPipelineRowKey(resource);
        const attempts = Number(state.branchAttempts[key] || 0);
        if (attempts >= 2) continue;
        state.branchAttempts[key] = attempts + 1;
        const row = domRowForResource(resource);
        if (!row) continue;
        try { row.scrollIntoView({ block: "nearest" }); } catch {}
        const beforeHeight = scroller.scrollHeight;
        if (!expandPlanningRow(row)) continue;
        const opened = await waitForPlanningBranchOpen(resource, beforeHeight, 1000);
        if (opened) {
          state.expandedSet.add(key);
          state.expandedCount += 1;
          state.bottomStablePasses = 0;
        }
        expandedSomething = true;
        state.scrollTop = scroller.scrollTop;
        break;
      }

      if (expandedSomething) continue;

      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const currentTop = Math.max(0, Math.min(maxTop, scroller.scrollTop));
      if (currentTop < maxTop - 2) {
        const step = Math.max(220, Math.floor(scroller.clientHeight * 0.82));
        const nextTop = Math.min(maxTop, currentTop + step);
        scroller.scrollTop = nextTop;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 35));
        state.scrollTop = nextTop;
        state.bottomStablePasses = 0;
        continue;
      }

      const beforeHeight = scroller.scrollHeight;
      await new Promise((resolve) => setTimeout(resolve, 110));
      const afterMaxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (scroller.scrollHeight > beforeHeight + 2 || afterMaxTop > maxTop + 2) {
        state.bottomStablePasses = 0;
        continue;
      }

      state.bottomStablePasses += 1;
      if (state.bottomStablePasses >= 2) {
        // ExtJS virtualise l'arbre : atteindre le bas d'un rendu n'est pas une
        // preuve suffisante que tout le périmètre a été parcouru. On effectue
        // donc un passage de confirmation depuis le haut. Si ce second passage
        // découvre ou ouvre encore quelque chose, on recommence jusqu'à stabilité.
        if (state.sweepIndex === 0) {
          state.sweepIndex = 1;
          state.sweepStartDiscovered = state.discoveredCount;
          state.sweepStartExpanded = state.expandedCount;
          state.bottomStablePasses = 0;
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 70));
          state.scrollTop = 0;
          continue;
        }

        const changedDuringSweep =
          state.discoveredCount > Number(state.sweepStartDiscovered || 0) ||
          state.expandedCount > Number(state.sweepStartExpanded || 0);

        if (changedDuringSweep) {
          state.sweepStartDiscovered = state.discoveredCount;
          state.sweepStartExpanded = state.expandedCount;
          state.bottomStablePasses = 0;
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 70));
          state.scrollTop = 0;
          continue;
        }

        state.done = true;
        return { ok: true, code: "ADE_PIPELINE_DONE", done: true, discoveredCount: state.discoveredCount, expandedCount: state.expandedCount };
      }
    }

    return {
      ok: true,
      code: "ADE_PIPELINE_CONTINUE",
      done: false,
      discoveredCount: state.discoveredCount,
      expandedCount: state.expandedCount
    };
  }

  function scrapeCurrentWeek() {
    const headers = findDayHeaders();
    const events = [];

    for (const el of document.querySelectorAll("div, td, span")) {
      if (!isLeafWithTime(el)) continue;

      const event = parseEvent(el, headers);

      if (event) events.push(event);
    }

    const cleanEvents = uniqueEvents(events).sort((a, b) =>
      `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`)
    );

    const planningResource = selectedPlanningResource();

    return {
      ok: headers.length >= 5,
      code: headers.length >= 5 ? "SCRAPE_OK" : "WEEK_HEADERS_NOT_FOUND",
      source: "university-planning",
      planningLabel: planningResource?.label || selectedPlanningLabel(),
      resourceId: planningResource?.resourceId ?? null,
      planningResource,
      week:
        headers.length >= 5
          ? {
              firstDate: headers[0].date,
              lastDate: headers[headers.length - 1].date
            }
          : null,
      events: cleanEvents,
      diagnostics: {
        href: location.href,
        dayHeaderCount: headers.length,
        eventCount: cleanEvents.length
      }
    };
  }


  function isoWeekNumber(isoDateValue) {
    const date = new Date(`${isoDateValue}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return null;

    const target = new Date(date.valueOf());
    const dayNr = (date.getUTCDay() + 6) % 7;

    target.setUTCDate(
      target.getUTCDate() -
      dayNr +
      3
    );

    const firstThursday =
      new Date(
        Date.UTC(
          target.getUTCFullYear(),
          0,
          4
        )
      );

    const firstDayNr =
      (
        firstThursday.getUTCDay() +
        6
      ) % 7;

    firstThursday.setUTCDate(
      firstThursday.getUTCDate() -
      firstDayNr +
      3
    );

    return (
      1 +
      Math.round(
        (
          target -
          firstThursday
        ) /
        604800000
      )
    );
  }

  function weekTabCandidates() {
    const values = [];

    for (
      const el
      of document.querySelectorAll(
        "button, a, td, div, span"
      )
    ) {
      if (!visible(el)) continue;

      const text =
        clean(
          String(
            el.innerText ||
            el.textContent ||
            ""
          )
            .replace(/\n+/g, " ")
        );

      const match =
        text.match(
          /^S(\d{1,2})\s+du\s+/i
        );

      if (
        !match ||
        text.length > 100
      ) {
        continue;
      }

      // Évite de retenir un grand conteneur qui contient déjà
      // plusieurs onglets de semaine.
      let childHasWeek = false;

      for (
        const child
        of el.children || []
      ) {
        const childText =
          clean(
            String(
              child.innerText ||
              child.textContent ||
              ""
            )
              .replace(/\n+/g, " ")
          );

        if (
          /^S\d{1,2}\s+du\s+/i.test(
            childText
          )
        ) {
          childHasWeek = true;
          break;
        }
      }

      if (childHasWeek) {
        continue;
      }

      const rect =
        el.getBoundingClientRect();

      values.push({
        el,
        text,
        active: Boolean(el.closest(".x-btn-pressed")),
        weekNumber:
          Number(match[1]),
        firstDate: parseWeekTabFirstDate(text),
        x:
          rect.left,
        width:
          rect.width
      });
    }

    const deduped =
      new Map();

    for (const item of values) {
      const key =
        `${item.weekNumber}|${item.text}`;

      const existing =
        deduped.get(key);

      if (
        !existing ||
        (item.el.matches("button, a, [role='button']") &&
          !existing.el.matches("button, a, [role='button']")) ||
        item.width < existing.width
      ) {
        deduped.set(
          key,
          item
        );
      }
    }

    return [
      ...deduped.values()
    ].sort(
      (a, b) =>
        a.x - b.x
    );
  }

  function clickLikeUser(el) {
    if (!(el instanceof Element)) {
      return false;
    }

    const target =
      (
        el.matches("button, a, [role='button']")
          ? el
          : el.querySelector("button, a, [role='button']")
      ) ||
      el.closest("button, a, [role='button'], td, div, span") ||
      el;

    try {
      target.scrollIntoView({
        block:
          "nearest",
        inline:
          "nearest"
      });
    } catch {}

    for (
      const type
      of [
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click"
      ]
    ) {
      try {
        target.dispatchEvent(
          new MouseEvent(
            type,
            {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0
            }
          )
        );
      } catch {}
    }

    try {
      if (
        typeof target.click ===
        "function"
      ) {
        target.click();
      }
    } catch {}

    return true;
  }

  function kickWeekNavigation(direction = "next", requestedWeekNumber = null, requestedFirstDate = null) {
    const scraped =
      scrapeCurrentWeek();

    const candidates =
      weekTabCandidates();

    const activeWeek = candidates.find((item) => item.active)?.weekNumber ?? null;
    const currentWeek =
      scraped?.week?.firstDate
        ? isoWeekNumber(
            scraped.week.firstDate
          )
        : activeWeek;

    if (!candidates.length) {
      return {
        ok: false,
        code:
          "V3_WEEK_TABS_NOT_FOUND",
        diagnostics: {
          href:
            location.href,
          currentWeek,
          candidateCount: 0
        }
      };
    }

    let target = null;

    // Quand la date exacte est connue, elle prime sur le numéro ISO. C'est
    // indispensable au passage décembre -> janvier : "S1" existe dans plusieurs
    // années et le numéro seul ne permet pas de choisir le bon onglet ADE.
    if (requestedFirstDate) {
      target = candidates.find((item) => item.firstDate === requestedFirstDate) || null;
    }

    // Le collecteur peut aussi demander une semaine ISO précise pour obtenir un
    // modèle GWT littéral. Cette voie reste utile tant qu'il n'y a pas
    // d'ambiguïté d'année.
    if (!target && Number.isInteger(Number(requestedWeekNumber))) {
      const wanted = Number(requestedWeekNumber);
      target = candidates.find((item) => item.weekNumber === wanted) || null;
    }

    if (
      !target &&
      Number.isInteger(
        currentWeek
      )
    ) {
      const delta = direction === "previous" ? -1 : 1;
      target =
        candidates.find(
          (item) =>
            item.weekNumber ===
            currentWeek + delta
        ) ||
        candidates.find(
          (item) =>
            item.weekNumber !==
            currentWeek
        ) ||
        null;
    }

    if (!target) {
      target =
        candidates.length >= 2
          ? candidates[1]
          : candidates[0];
    }

    if (
      Number.isInteger(
        currentWeek
      ) &&
      target.weekNumber ===
        currentWeek &&
      candidates.length > 1
    ) {
      target =
        candidates.find(
          (item) =>
            item.weekNumber !==
            currentWeek
        ) || target;
    }

    const clicked =
      clickLikeUser(
        target.el
      );

    return {
      ok:
        Boolean(clicked),
      code:
        clicked
          ? "V3_WEEK_KICKED"
          : "V3_WEEK_KICK_FAILED",
      fromWeekNumber:
        currentWeek,
      targetWeekNumber:
        target.weekNumber,
      targetFirstDate:
        target.firstDate || null,
      targetLabel:
        target.text,
      diagnostics: {
        href:
          location.href,
        candidateCount:
          candidates.length,
        candidates:
          candidates
            .slice(0, 14)
            .map(
              (item) => ({
                weekNumber:
                  item.weekNumber,
                firstDate:
                  item.firstDate || null,
                text:
                  item.text
              })
            )
      }
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;

    if (message.type === "PLANILIM_PING") {
      sendResponse({
        ok: true,
        href: location.href
      });
      return;
    }

    if (message.type === "PLANILIM_SCRAPE_ADE" || message.type === "MON_EDT_V4_SCRAPE_PREVIEW") {
      sendResponse(scrapeCurrentWeek());
      return;
    }

    if (message.type === "MON_EDT_V4_KICK_WEEK") {
      sendResponse(kickWeekNavigation(
        message.direction,
        message.targetWeekNumber,
        message.targetFirstDate || null
      ));
      return;
    }

      if (message.type === "PLANILIM_ADE_TREE_SNAPSHOT") {
        sendResponse(planningTreeSnapshot());
        return;
      }

    if (message.type === "PLANILIM_ADE_TREE_SCAN") {
      scanPlanningTree()
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          code: "ADE_TREE_SCAN_FAILED",
          message: String(error)
        }));
      return true;
    }

    if (message.type === "PLANILIM_ADE_EXPAND_AND_SCAN") {
      expandAllPlanningBranches(message.options || {})
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          code: "ADE_TREE_EXPANSION_FAILED",
          message: String(error)
        }));
      return true;
    }

    if (message.type === "PLANILIM_ADE_PIPELINE_RESET") {
      sendResponse(collectorPipelineResetState());
      return;
    }

    if (message.type === "PLANILIM_ADE_PIPELINE_NEXT") {
      collectorPipelineNext(message.options || {})
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          code: "ADE_PIPELINE_STEP_FAILED",
          message: String(error)
        }));
      return true;
    }

    if (message.type === "PLANILIM_ADE_SELECT_RESOURCE") {
      selectPlanningResource(message.target || message, message.options || {})
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          code: "ADE_RESOURCE_SELECTION_FAILED",
          message: String(error)
        }));
      return true;
    }

    if (message.type === "PLANILIM_ADE_TOGGLE_BRANCH") {
      togglePlanningBranch(message.target || message)
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          code: "ADE_BRANCH_TOGGLE_FAILED",
          message: String(error)
        }));
      return true;
    }
  });
})();

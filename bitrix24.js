// =======================
// VARIÁVEIS GLOBAIS
// =======================
var tasksFields;
var domain;
var language;
var token;
var currentUser;
var users = {};

var usersLoaded = false;

var gridApi = null;
var gridColumnApi = null;
var isDataLoading = false;

// IDs dos departamentos que representam "Serviços"
var SERVICE_DEPARTMENT_IDS = [9];

// =======================
// BLOQUEIOS / REGRAS FIXAS
// =======================
var BLOCKED_TASK_IDS = [51311, 51313];

// Como identificar "NOC" pelo responsável (ajuste se quiser deixar mais rígido)
function isNocResponsible(task) {
    var name = (task && task.responsibleName) ? String(task.responsibleName) : "";
    return /noc/i.test(name); // pega "NOC", "noc", etc.
}

function isBlockedTask(task) {
    if (!task) return false;
    var idNum = parseInt(task.id, 10);
    if (isNaN(idNum)) return false;
    return BLOCKED_TASK_IDS.indexOf(idNum) !== -1;
}

// Normaliza rótulo do mês ("jan.", "jan", etc.)
function normalizeMonthLabel(label) {
    return String(label || "")
        .toLowerCase()
        .replace(".", "")
        .trim();
}

// Mapeamento do STATUS numérico -> texto
var taskStatus = {
    2: "Pendente",
    3: "Em progresso",
    4: "Revisão Pendente",
    5: "Completado",
    6: "Adiado"
};

var dataSourceTasks = [];      // só ABERTAS (dashboard / grid)
var allTasksForExport = null;  // cache com TODAS (abertas + concluídas) para export

var chartOpenByMonth = null;
var chartType = null;
var chartResponsavel = null;

// últimas tarefas abertas usadas no dashboard/grid
var currentOpenTasks = [];

// estado simples de filtro aplicado via gráfico
var gridFilterState = {
    mode: null,   // 'responsavel' | 'tipo' | 'mes' | null
    value: null
};

// =======================
// DOCUMENT READY – UI
// =======================
$(document).ready(function () {
    console.log('[Relatório] document.ready rodou');

    // painel de exportação
    const btnOpen = document.getElementById('btn-open-export');
    const btnClose = document.getElementById('btn-close-export');
    const backdrop = document.getElementById('export-backdrop');
    const panel = document.getElementById('export-panel');

    function openExportPanel() {
        if (!panel || !backdrop) return;
        panel.classList.add('open');
        backdrop.classList.add('show');

        // padrão: abre com base "abertas"
        populateExportResponsavel(dataSourceTasks);
    }

    function closeExportPanel() {
        if (!panel || !backdrop) return;
        panel.classList.remove('open');
        backdrop.classList.remove('show');
    }

    if (btnOpen) btnOpen.addEventListener('click', openExportPanel);
    if (btnClose) btnClose.addEventListener('click', closeExportPanel);
    if (backdrop) backdrop.addEventListener('click', closeExportPanel);

    // ✅ NOVO: ao mudar o status do export (abertas/fechadas/todas),
    // atualiza a lista de responsáveis com a BASE correta
    var exportStatusEl = document.getElementById('export-status');
    if (exportStatusEl) {
        exportStatusEl.addEventListener('change', function () {
            var v = this.value || 'all';

            if (v === 'open') {
                // lista de responsáveis só das abertas
                populateExportResponsavel(dataSourceTasks);
            } else {
                // fechadas ou todas -> carrega base completa e popula com todos
                loadAllTasksForExport(function (allTasks) {
                    populateExportResponsavel(allTasks);
                });
            }
        });
    }

    // BOTÕES DO PAINEL DE EXPORTAÇÃO
    var btnApplyExport = document.getElementById('btn-apply-filters');
    var btnExportCsv   = document.getElementById('btn-export-csv');
    var btnExportXlsx  = document.getElementById('btn-export-xlsx');

    if (btnApplyExport) {
        btnApplyExport.addEventListener('click', function (e) {
            if (e) { e.preventDefault(); e.stopPropagation(); }

            var statusEl = document.getElementById('export-status');
            var statusFilter = statusEl ? statusEl.value : 'all';

            // se for só abertos -> usa dataSourceTasks (abertas)
            if (statusFilter === 'open') {
                var filtered = getFilteredTasksForExport(); // base padrão = abertas
                console.log("Total de registros para exportar (abertas):", filtered.length);
                var spanCount = document.getElementById('export-count');
                if (spanCount) spanCount.innerText = filtered.length;
            } else {
                // quando ele quiser 'fechadas' ou 'todas' -> puxa TUDO (abertas + concluídas)
                loadAllTasksForExport(function (allTasks) {
                    var filtered = getFilteredTasksForExport(allTasks);
                    console.log("Total de registros para exportar (base todas):", filtered.length);
                    var spanCount = document.getElementById('export-count');
                    if (spanCount) spanCount.innerText = filtered.length;
                });
            }
        });
    }

    // (o restante do seu document.ready continua igual abaixo...)
});

    // Clique Exportar CSV
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', function () {
            var statusEl = document.getElementById('export-status');
            var statusFilter = statusEl ? statusEl.value : 'all';

            if (statusFilter === 'open') {
                var filtered = getFilteredTasksForExport(); // base abertas
                exportTasksToCsv(filtered);
            } else {
                loadAllTasksForExport(function (allTasks) {
                    var filtered = getFilteredTasksForExport(allTasks);
                    exportTasksToCsv(filtered);
                });
            }
        });
    }

    // Clique Exportar XLSX
    if (btnExportXlsx) {
        btnExportXlsx.addEventListener('click', function () {
            var statusEl = document.getElementById('export-status');
            var statusFilter = statusEl ? statusEl.value : 'all';

            if (statusFilter === 'open') {
                var filtered = getFilteredTasksForExport(); // base abertas
                exportTasksToXlsx(filtered);
            } else {
                loadAllTasksForExport(function (allTasks) {
                    var filtered = getFilteredTasksForExport(allTasks);
                    exportTasksToXlsx(filtered);
                });
            }
        });
    }

    // inicializa os gráficos ECharts
    initCharts();

    // inicializa o grid
    const eGridDiv = document.getElementById("myGrid");
    if (eGridDiv && window.agGrid) {
        console.log('[Relatório] Inicializando AG Grid');
        new agGrid.Grid(eGridDiv, gridOptions);
    } else {
        console.warn('[Relatório] myGrid ou agGrid não encontrados');
    }


// =======================
// FUNÇÃO CENTRAL: ABERTAS (para dashboard / grid)
// =======================
function getOpenTasks() {
    // abertas = qualquer statusCode diferente de 5 (Completado)
    // e nunca permite IDs bloqueados
    return (dataSourceTasks || []).filter(function (t) {
        if (isBlockedTask(t)) return false;

        if (typeof t.statusCode === 'number') {
            return t.statusCode !== 5;
        }
        return t.status !== "Completado";
    });
}

function refreshDashboardAndGrid() {
    var openTasks = getOpenTasks();
    currentOpenTasks = openTasks.slice(); // guarda para filtros por gráfico

    if (gridApi) {
        gridApi.setRowData(openTasks);
    }
    // sempre que recarregar, limpa estado de filtro aplicado via gráfico
    gridFilterState.mode = null;
    gridFilterState.value = null;

    updateDashboard(openTasks);
}

// =======================
// FILTRO EXPORTAÇÃO
// baseTasks opcional: se passar, usa essa base; senão usa dataSourceTasks (abertas)
// =======================
function getFilteredTasksForExport(baseTasks) {
    var periodEl = document.getElementById('export-period');
    var statusEl = document.getElementById('export-status');
    var respEl = document.getElementById('export-responsavel');

    var period = periodEl ? periodEl.value : 'all';
    var statusFilter = statusEl ? statusEl.value : 'all';

    // múltiplos responsáveis selecionados
    var selectedResps = [];
    if (respEl && respEl.options) {
        for (var i = 0; i < respEl.options.length; i++) {
            var opt = respEl.options[i];
            if (opt.selected && opt.value !== 'all') {
                selectedResps.push(opt.value);
            }
        }
    }

    // se não passar baseTasks -> usa dataSourceTasks (abertas)
    var base = baseTasks || dataSourceTasks || [];
    var now = new Date();

    return base.filter(function (t) {
        // nunca exporta bloqueadas
        if (isBlockedTask(t)) return false;

        var ok = true;

        // período: 30 / 60 / 120 dias ou 'all'
        if (period !== 'all') {
            var days = parseInt(period, 10);
            if (!isNaN(days)) {
                var limit = new Date(now);
                limit.setDate(now.getDate() - days);

                var changed = t.changedDateRaw ? new Date(t.changedDateRaw) : null;
                if (!changed || changed < limit) ok = false;
            }
        }

        // status (aberto / fechado / todos)
        if (statusFilter === 'open') {
            if (typeof t.statusCode === 'number') {
                if (t.statusCode === 5) ok = false;
            } else if (t.status === "Completado") {
                ok = false;
            }
        }

        if (statusFilter === 'closed') {
            if (typeof t.statusCode === 'number') {
                if (t.statusCode !== 5) ok = false;
            } else if (t.status !== "Completado") {
                ok = false;
            }
        }
        // statusFilter === 'all' -> não filtra por status (pega abertas + concluídas)

        // filtro por LISTA de responsáveis
        if (selectedResps.length > 0) {
            if (selectedResps.indexOf(t.responsibleName) === -1) {
                ok = false;
            }
        }

        return ok;
    });
}

// =======================
// ECHARTS - INICIALIZAÇÃO
// =======================
function initCharts() {
    if (typeof echarts === 'undefined') return;

    var el1 = document.getElementById('chart-open-by-month');
    var el2 = document.getElementById('chart-type');
    var el3 = document.getElementById('chart-responsavel');

    if (el1) chartOpenByMonth = echarts.init(el1);
    if (el2) chartType = echarts.init(el2);
    if (el3) chartResponsavel = echarts.init(el3);
}

// =======================
// PROGRESSO DE EXPORTAÇÃO
// =======================
function setExportProgressVisible(show) {
    var box = document.getElementById('export-progress');
    var btnCsv = document.getElementById('btn-export-csv');
    var btnXlsx = document.getElementById('btn-export-xlsx');

    if (box) box.style.display = show ? 'block' : 'none';
    if (btnCsv) btnCsv.disabled = !!show;
    if (btnXlsx) btnXlsx.disabled = !!show;
}

function updateExportProgress(current, total) {
    var bar = document.getElementById('export-progress-bar');
    var text = document.getElementById('export-progress-text');
    if (!bar || !text) return;

    var percent = total > 0 ? Math.round((current / total) * 100) : 0;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;

    bar.style.width = percent + '%';
    text.textContent = 'Exportando ' + current + ' de ' + total + ' registros... (' + percent + '%)';
}

// =======================
// EXPORT CSV (COM PROGRESSO EM LOTES)
// =======================
function exportTasksToCsv(tasks) {
    if (!tasks || !tasks.length) {
        alert("Nenhum registro para exportar.");
        return;
    }

    // mostra barra de progresso
    setExportProgressVisible(true);
    updateExportProgress(0, tasks.length);

    var cols = [
        "id", "title", "description", "company",
        "pmo", "contract", "service",
        "ufAuto793377858165", "ufAuto856888266589",
        "status", "timeSpentInLogs",
        "createdDate", "changedDate", "dateStart", "closedDate",
        "createdBy", "changedBy", "responsibleName"
    ];

    var header = cols.join(";");
    var lines = [header];

    var total = tasks.length;
    var chunkSize = 500; // quantidade de linhas por "lote"
    var index = 0;

    function processChunk() {
        var end = Math.min(index + chunkSize, total);

        for (var i = index; i < end; i++) {
            var t = tasks[i];

            // segurança extra
            if (isBlockedTask(t)) continue;

            var row = cols.map(function (c) {
                var v = (t[c] !== undefined && t[c] !== null) ? String(t[c]) : "";
                v = v.replace(/"/g, '""');
                if (v.indexOf(";") >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0) {
                    v = '"' + v + '"';
                }
                return v;
            }).join(";");
            lines.push(row);
        }

        index = end;
        updateExportProgress(index, total);

        if (index < total) {
            // agenda o próximo lote para não travar a tela
            setTimeout(processChunk, 0);
        } else {
            // terminou tudo → gera arquivo e baixa
            var csvContent = lines.join("\n");
            var blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
            var url = URL.createObjectURL(blob);

            var a = document.createElement("a");
            a.href = url;
            a.download = "relatorio_tarefas.csv";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // esconde barra e libera botões
            setExportProgressVisible(false);
        }
    }

    // inicia o primeiro lote
    processChunk();
}

// =======================
// EXPORT XLSX SIMPLES
// =======================
function exportTasksToXlsx(tasks) {
    if (!tasks || !tasks.length) {
        alert("Nenhum registro para exportar.");
        return;
    }

    setExportProgressVisible(true);
    updateExportProgress(0, tasks.length);

    ensureSheetJs(function () {
        var cols = [
            "id", "title", "description", "company",
            "pmo", "contract", "service",
            "ufAuto793377858165", "ufAuto856888266589",
            "status", "timeSpentInLogs",
            "createdDate", "changedDate", "dateStart", "closedDate",
            "createdBy", "changedBy", "responsibleName"
        ];

        // monta AOA (linha 1 = header)
        var aoa = [cols];
        var total = tasks.length;

        for (var i = 0; i < total; i++) {
            var t = tasks[i];
            if (isBlockedTask(t)) continue;

            var row = cols.map(function (c) {
                var v = (t[c] !== undefined && t[c] !== null) ? t[c] : "";
                return v; // pode ser string/number
            });

            aoa.push(row);

            if ((i % 200) === 0) updateExportProgress(i + 1, total);
        }

        updateExportProgress(total, total);

        var ws = XLSX.utils.aoa_to_sheet(aoa);

        // largura de colunas (opcional)
        ws['!cols'] = cols.map(function (c) {
            return { wch: Math.min(40, Math.max(12, c.length + 2)) };
        });

        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Relatório");

        XLSX.writeFile(wb, "relatorio_tarefas.xlsx");

        setExportProgressVisible(false);
    });
}

// =======================
// MINI ZIP PARA XLSX
// =======================
function generateSimpleZip(files) {
    var parts = [];
    var fileList = [];
    var offset = 0;

    for (var path in files) {
        if (!files.hasOwnProperty(path)) continue;

        var content = new TextEncoder("utf-8").encode(files[path]);
        var header = createZipHeader(path, content.length);

        parts.push(header);
        parts.push(content);

        fileList.push({
            path: path,
            size: content.length,
            offset: offset
        });

        offset += header.length + content.length;
    }

    var dirParts = [];
    var dirSize = 0;

    fileList.forEach(function (f) {
        var cd = createCentralDirectory(f.path, f.size, f.offset);
        dirParts.push(cd);
        dirSize += cd.length;
    });

    parts = parts.concat(dirParts);

    var end = createEndOfCentralDirectory(fileList.length, dirSize, offset);
    parts.push(end);

    return new Blob(parts, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
}

function createZipHeader(path, size) {
    var p = new TextEncoder("utf-8").encode(path);
    var header = new Uint8Array(30 + p.length);
    var dv = new DataView(header.buffer);

    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true);        // version
    dv.setUint16(6, 0, true);         // flags
    dv.setUint16(8, 0, true);         // compression (0 = store)
    dv.setUint16(10, 0, true);        // mod time
    dv.setUint16(12, 0, true);        // mod date
    dv.setUint32(14, 0, true);        // crc32 (0 para simplificar)
    dv.setUint32(18, size, true);     // compressed size
    dv.setUint32(22, size, true);     // uncompressed size
    dv.setUint16(26, p.length, true); // file name length
    dv.setUint16(28, 0, true);        // extra length

    header.set(p, 30);
    return header;
}

function createCentralDirectory(path, size, offset) {
    var p = new TextEncoder("utf-8").encode(path);
    var cd = new Uint8Array(46 + p.length);
    var dv = new DataView(cd.buffer);

    dv.setUint32(0, 0x02014b50, true); // central dir signature
    dv.setUint16(4, 20, true);         // version made by
    dv.setUint16(6, 20, true);         // version needed
    dv.setUint16(8, 0, true);          // flag
    dv.setUint16(10, 0, true);         // compression
    dv.setUint16(12, 0, true);         // time
    dv.setUint16(14, 0, true);         // date
    dv.setUint32(16, 0, true);         // crc32
    dv.setUint32(20, size, true);      // compressed size
    dv.setUint32(24, size, true);      // uncompressed size
    dv.setUint16(28, p.length, true);  // file name length
    dv.setUint16(30, 0, true);         // extra
    dv.setUint16(32, 0, true);         // comment
    dv.setUint16(34, 0, true);         // disk number
    dv.setUint16(36, 0, true);         // internal attrs
    dv.setUint32(38, 0, true);         // external attrs
    dv.setUint32(42, offset, true);    // local header offset

    cd.set(p, 46);
    return cd;
}

function createEndOfCentralDirectory(count, dirSize, offset) {
    var eocd = new Uint8Array(22);
    var dv = new DataView(eocd.buffer);

    dv.setUint32(0, 0x06054b50, true); // signature
    dv.setUint16(4, 0, true);          // disk number
    dv.setUint16(6, 0, true);          // start disk
    dv.setUint16(8, count, true);      // entries on this disk
    dv.setUint16(10, count, true);     // total entries
    dv.setUint32(12, dirSize, true);   // size of central dir
    dv.setUint32(16, offset, true);    // offset of central dir
    dv.setUint16(20, 0, true);         // comment length

    return eocd;
}

function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// =======================
// AG-GRID
// =======================
const gridOptions = {
    columnDefs: [
        { field: "id", headerName: "Id", width: 90 },
        { field: "title", headerName: "Nome", width: 230 },
        { field: "createdDate", headerName: "Data Criação", filter: 'agDateColumnFilter', width: 160 },
        { field: "timeSpentInLogs", headerName: "Tempo gasto (minutos)", width: 160 },
        { field: "company", headerName: "Empresa", width: 230 },
        { field: "responsibleName", headerName: "Responsável", width: 220 },
        { field: "pmo", headerName: "PMO", width: 180 },
        { field: "contract", headerName: "Contratos", width: 200 },
        { field: "service", headerName: "Serviços", width: 200 },
        { field: "ufAuto793377858165", headerName: "Categoria", width: 200 },
        { field: "ufAuto856888266589", headerName: "Comentário de Encerramento", width: 220 }
    ],

    defaultColDef: {
        sortable: true,
        resizable: true,
        filter: true
    },

    onGridReady: function (params) {
        console.log('[Relatório] onGridReady');
        gridApi = params.api;
        gridColumnApi = params.columnApi;

        if (dataSourceTasks && dataSourceTasks.length) {
            refreshDashboardAndGrid();
        }
    },

    pagination: true,
    rowData: [],
    animateRows: true,

    onCellClicked: params => {
        if (!params || !params.data) return;

        // Clicou no título → abre a tarefa
        if (params.colDef.field === 'title' && params.data.id) {
            let url = "https://interatell.bitrix24.com.br/company/personal/user/5/tasks/task/view/" + params.data.id + "/";
            window.open(url, '_blank').focus();
            return;
        }

        // Clicou no responsável → abre lista de tarefas do usuário
        if (params.colDef.field === 'responsibleName' && params.data.responsibleId) {
            let url = "https://interatell.bitrix24.com.br/company/personal/user/" + params.data.responsibleId + "/tasks/";
            window.open(url, '_blank').focus();
            return;
        }
    }
};

// =======================
// BX24 - INICIALIZAÇÃO
// =======================
BX24.init(function () {
    BX24.ready(function () {
        start();
    });
});

function start() {
    console.log("BX24.Init BX24.isAdmin", BX24.isAdmin());
    token = BX24.getAuth();
    domain = BX24.getDomain();
    language = BX24.getLang();
    language = (language === "br") ? "pt" : "en";

    getUserCurrent();

    getUsers(function () {
        // carrega automaticamente tarefas ABERTAS (STATUS != 5) para dashboard/grid
        loadTasksOpenOnly();

        // atualiza periodicamente se quiser
        setInterval(function () {
            if (!isDataLoading) {
                loadTasksOpenOnly();
            }
        }, 1 * 60 * 1000);
    });
}

// =======================
// USUÁRIOS
// =======================
function getUserCurrent() {
    send("user.current", {}, function (result) {
        currentUser = result.answer.result;
    });
}

function buildUserFullName(u) {
    var parts = [];
    if (u.NAME) parts.push(u.NAME);
    if (u.LAST_NAME) parts.push(u.LAST_NAME);
    var full = parts.join(" ").trim();
    if (!full && u.EMAIL) full = u.EMAIL;
    if (!full) full = "ID " + u.ID;
    return full;
}

function getUsers(callback) {
    users = {};
    usersLoaded = false;

    send("user.get", {}, function handleUsers(result, isLastPage) {
        var list = result.answer.result;

        if (Array.isArray(list)) {
            list.forEach(function (u) {
                u._FULL_NAME = buildUserFullName(u);
                users[u.ID] = u;
            });
        }

        if (isLastPage) {
            console.log("[Relatório] getUsers finalizado. Total usuários:", Object.keys(users).length);
            usersLoaded = true;
            if (typeof callback === 'function') callback();
        }
    });
}

// =======================
// HELPERS DEPARTAMENTO
// =======================
function getUserDepartmentsArray(u) {
    var deps = [];
    if (!u) return deps;

    if (u.UF_DEPARTMENT) {
        if (Array.isArray(u.UF_DEPARTMENT)) {
            deps = u.UF_DEPARTMENT;
        } else {
            deps = [u.UF_DEPARTMENT];
        }
    }

    return deps
        .map(function (d) { return parseInt(d, 10); })
        .filter(function (d) { return !isNaN(d); });
}

function isServiceUser(u) {
    var deps = getUserDepartmentsArray(u);
    if (!deps.length) return false;

    return deps.some(function (id) {
        return SERVICE_DEPARTMENT_IDS.indexOf(id) !== -1;
    });
}

function taskAllowedByServiceDepartment(task) {
    if (!task) return false;
    if (!task.responsibleId) return false;

    var u = users[task.responsibleId];
    if (!u) return false;

    return isServiceUser(u);
}

// =======================
// CARREGAR TAREFAS ABERTAS (STATUS != 5) – DASHBOARD
// =======================
function loadTasksOpenOnly() {
    console.log("loadTasksOpenOnly() chamado");

    if (!usersLoaded) {
        console.log("Usuários ainda não carregados, abortando loadTasksOpenOnly");
        return;
    }

    isDataLoading = true;
    dataSourceTasks = [];
    allTasksForExport = null; // invalida cache

    const standard = {
        select: [
            "TITLE",
            "DESCRIPTION",
            "DEADLINE",
            "START_DATE_PLAN",
            "END_DATE_PLAN",
            "RESPONSIBLE_ID",
            "CREATED_BY",
            "STATUS",
            "DATE_START",
            "CREATED_DATE",
            "CHANGED_BY",
            "CHANGED_DATE",
            "CLOSED_BY",
            "CLOSED_DATE",
            "COMMENTS_COUNT",
            "TIME_SPENT_IN_LOGS",
            "UF_CRM_TASK",
            "UF_AUTO_793377858165",
            "UF_AUTO_856888266589"
        ],
        filter: {
            "!STATUS": 5 // somente não concluídas
        }
    };

    send("tasks.task.list", standard, function (result, isLastPage) {
        console.log('setTasks (openOnly) chamado');

        if (
            !result ||
            !result.answer ||
            !result.answer.result ||
            !Array.isArray(result.answer.result.tasks)
        ) {
            console.warn('setTasks: resposta vazia ou inválida', result);
            if (isLastPage) {
                isDataLoading = false;
                refreshDashboardAndGrid();
            }
            return;
        }

        const fixed = fixField(result.answer.result.tasks || []);
        const filtered = fixed
            .filter(taskAllowedByServiceDepartment)
            .filter(function (t) { return !isBlockedTask(t); });

        console.log(
            "Total tasks retornadas (abertas):", fixed.length,
            " | Após filtro por departamento Serviços + bloqueios:", filtered.length
        );

        dataSourceTasks = dataSourceTasks.concat(filtered);

        if (isLastPage) {
            console.log('setTasks: terminou paginação abertas, atualizando dashboard/grid');
            isDataLoading = false;
            refreshDashboardAndGrid();
            populateExportResponsavel(dataSourceTasks);
        }
    });
}

// =======================
// CARREGAR TODAS AS TAREFAS (ABERTAS + CONCLUÍDAS) – SOMENTE EXPORT
// =======================
function loadAllTasksForExport(callback) {
    // se já carregou uma vez, usa cache
    if (allTasksForExport && allTasksForExport.length) {
        callback(allTasksForExport);
        return;
    }

    console.log("loadAllTasksForExport() chamado");

    var collected = [];

    const standard = {
        select: [
            "TITLE",
            "DESCRIPTION",
            "DEADLINE",
            "START_DATE_PLAN",
            "END_DATE_PLAN",
            "RESPONSIBLE_ID",
            "CREATED_BY",
            "STATUS",
            "DATE_START",
            "CREATED_DATE",
            "CHANGED_BY",
            "CHANGED_DATE",
            "CLOSED_BY",
            "CLOSED_DATE",
            "COMMENTS_COUNT",
            "TIME_SPENT_IN_LOGS",
            "UF_CRM_TASK",
            "UF_AUTO_793377858165",
            "UF_AUTO_856888266589"
        ],
        filter: {
            // sem filtro de STATUS -> todas
        }
    };

    send("tasks.task.list", standard, function (result, isLastPage) {
        console.log('setTasks (all for export) chamado');

        if (
            !result ||
            !result.answer ||
            !result.answer.result ||
            !Array.isArray(result.answer.result.tasks)
        ) {
            console.warn('setTasks: resposta vazia ou inválida em loadAllTasksForExport', result);
            if (isLastPage) {
                allTasksForExport = collected;
                callback(allTasksForExport);
            }
            return;
        }

        const fixed = fixField(result.answer.result.tasks || []);
        const filtered = fixed
            .filter(taskAllowedByServiceDepartment)
            .filter(function (t) { return !isBlockedTask(t); });

        collected = collected.concat(filtered);

        if (isLastPage) {
            console.log('loadAllTasksForExport: terminou paginação, total após depto serviços + bloqueios:', collected.length);
            allTasksForExport = collected;
            callback(allTasksForExport);
        }
    });
}

// =======================
// NORMALIZA CAMPOS
// =======================
function fixField(data) {
    let newData = data;
    for (let index = 0; index < newData.length; index++) {
        const element = newData[index];

        // closedBy -> nome
        if (newData[index].closedBy && newData[index].closedBy != "0"
            && newData[index].closedBy != null && newData[index].closedBy != undefined) {
            if (users[element.closedBy]) {
                newData[index].closedBy = users[element.closedBy]._FULL_NAME;
            } else {
                newData[index].closedBy = "ID " + element.closedBy;
            }
        } else {
            newData[index].closedBy = "";
        }

        // datas com proteção
        const createdOriginal = new Date(newData[index].createdDate);
        const changedOriginal = new Date(newData[index].changedDate);
        const dateStartOriginal = newData[index].dateStart ? new Date(newData[index].dateStart) : null;
        const closedDateOriginal = newData[index].closedDate ? new Date(newData[index].closedDate) : null;

        if (!isNaN(createdOriginal.getTime())) {
            newData[index].createdDateRaw = createdOriginal.toISOString();

            var rawLabel = createdOriginal.toLocaleString("pt-BR", { month: "short" });
            newData[index].createdMonthLabel = normalizeMonthLabel(rawLabel);
            newData[index].createdMonth = createdOriginal.getMonth(); // 0..11
            newData[index].createdYear = createdOriginal.getFullYear();

            newData[index].createdDate = createdOriginal.toLocaleString("pt-BR");
        } else {
            newData[index].createdDateRaw = null;
            newData[index].createdMonthLabel = "";
            newData[index].createdMonth = null;
            newData[index].createdYear = null;
            newData[index].createdDate = "";
        }

        if (!isNaN(changedOriginal.getTime())) {
            newData[index].changedDateRaw = changedOriginal.toISOString();
            newData[index].changedDate = changedOriginal.toLocaleString("pt-BR");
        } else {
            newData[index].changedDateRaw = null;
            newData[index].changedDate = "";
        }

        // status numérico original (STATUS)
        let statusCode = null;
        if (element.status !== undefined && element.status !== null) {
            statusCode = parseInt(element.status, 10);
        }
        newData[index].statusCode = isNaN(statusCode) ? null : statusCode;

        // status texto para exibir
        if (newData[index].statusCode !== null && taskStatus[newData[index].statusCode]) {
            newData[index].status = taskStatus[newData[index].statusCode];
        } else {
            newData[index].status = newData[index].status;
        }

        // id numérico
        newData[index].id = parseInt(newData[index].id, 10) || newData[index].id;

        // tempo em logs -> minutos
        newData[index].timeSpentInLogs = newData[index].timeSpentInLogs
            ? newData[index].timeSpentInLogs / 60
            : 0;

        // changedBy -> nome (fallback pra ID)
        if (users[element.changedBy]) {
            newData[index].changedBy = users[element.changedBy]._FULL_NAME;
        } else if (element.changedBy && element.changedBy !== "0") {
            newData[index].changedBy = "ID " + element.changedBy;
        } else {
            newData[index].changedBy = "";
        }

        // createdBy -> nome (fallback pra ID)
        if (users[element.createdBy]) {
            newData[index].createdBy = users[element.createdBy]._FULL_NAME;
        } else if (element.createdBy && element.createdBy !== "0") {
            newData[index].createdBy = "ID " + element.createdBy;
        } else {
            newData[index].createdBy = "";
        }

        // guarda SEMPRE o ID bruto do responsável
        newData[index].responsibleId = element.responsibleId || null;

        // cria um campo só pro NOME do responsável
        if (users[element.responsibleId]) {
            newData[index].responsibleName = users[element.responsibleId]._FULL_NAME;
        } else if (element.responsibleId && element.responsibleId !== "0") {
            newData[index].responsibleName = "ID " + element.responsibleId;
        } else {
            newData[index].responsibleName = "Sem responsável";
        }

        // --- usa as TAGS UF_CRM_TASK para marcar PMO / CONTRATOS / SERVIÇOS / EMPRESA ---
        var uf = newData[index].ufCrmTask || [];
        var hasServico  = false;
        var hasPmo      = false;
        var hasContrato = false;
        var hasCompany  = false;

        uf.forEach(function (code) {
            if (!code) return;
            var parts = String(code).split("_");
            var prefix = parts[0];

            if (prefix === "Tb9") hasServico  = true;   // Serviços
            if (prefix === "T86") hasPmo      = true;   // PMO
            if (prefix === "Taf") hasContrato = true;   // Contratos
            if (prefix === "CO")  hasCompany  = true;   // Empresa
        });

        newData[index].service  = hasServico  ? "Serviço"   : "";
        newData[index].pmo      = hasPmo      ? "PMO"       : "";
        newData[index].contract = hasContrato ? "Contrato"  : "";
        newData[index].company  = hasCompany  ? "Empresa"   : "";

        // datas formatadas
        newData[index].dateStart = (dateStartOriginal && !isNaN(dateStartOriginal.getTime()))
            ? dateStartOriginal.toLocaleString("pt-BR")
            : 'x';

        newData[index].closedDate = (closedDateOriginal && !isNaN(closedDateOriginal.getTime()))
            ? closedDateOriginal.toLocaleString("pt-BR")
            : '';
    }
    return newData;
}

// =======================
// FILTRO PELOS GRÁFICOS
// =======================
function applyGridFilterByResponsavel(responsavelNome) {
    if (!gridApi) return;

    // toggle: se clicar de novo no mesmo, limpa
    if (gridFilterState.mode === 'responsavel' && gridFilterState.value === responsavelNome) {
        gridFilterState.mode = null;
        gridFilterState.value = null;
        gridApi.setRowData(currentOpenTasks);

        // volta KPIs para o total geral (todas abertas)
        updateKpisForSubset(currentOpenTasks);
        return;
    }

    var filtered = currentOpenTasks.filter(function (t) {
        return (t.responsibleName === responsavelNome);
    });

    gridFilterState.mode = 'responsavel';
    gridFilterState.value = responsavelNome;

    gridApi.setRowData(filtered);

    // KPIs passam a mostrar só desse responsável
    updateKpisForSubset(filtered);
}

function applyGridFilterByMonth(monthIndex) {
    if (!gridApi) return;

    var year = (typeof selectedOpenYear === 'number') ? selectedOpenYear : new Date().getFullYear();

    // toggle
    if (gridFilterState.mode === 'mes' && gridFilterState.value === monthIndex) {
        gridFilterState.mode = null;
        gridFilterState.value = null;
        gridApi.setRowData(currentOpenTasks);
        updateKpisForSubset(currentOpenTasks);
        return;
    }

    var filtered = currentOpenTasks.filter(function (t) {
        return (t.createdYear === year && t.createdMonth === monthIndex);
    });

    gridFilterState.mode = 'mes';
    gridFilterState.value = monthIndex;

    gridApi.setRowData(filtered);
    updateKpisForSubset(filtered);
}

function ensureSheetJs(callback) {
    if (window.XLSX) { callback(); return; }

    var s = document.createElement('script');
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = function () { callback(); };
    s.onerror = function () {
        setExportProgressVisible(false);
        alert("Não consegui carregar a biblioteca XLSX (bloqueio de rede/CSP). Use CSV ou hospede o arquivo xlsx.full.min.js localmente.");
    };
    document.head.appendChild(s);
}


// =======================
// CLASSIFICAÇÃO TIPO (lógica do BI)
// =======================
function classifyTaskType(t) {
    var hasPmo      = !!t.pmo;
    var hasContrato = !!t.contract;
    var hasServico  = !!t.service;

    var title     = (t.title || "").toLowerCase();
    var categoria = (t.ufAuto793377858165 || "").toLowerCase();

    var hasManutencaoPreventiva =
        title.indexOf("manutenção preventiva") !== -1 ||
        categoria.indexOf("manutenção preventiva") !== -1;

    if (hasPmo) return "Projetos";

    if (hasContrato && hasManutencaoPreventiva) return "Manutenção Preventiva";

    if (!hasPmo && !hasContrato && !hasServico) {
        // NOC só conta se o responsável for NOC
        return isNocResponsible(t) ? "NOC" : "";
    }

    if (hasContrato) return "Contratos";

    if (hasServico) return "Serviços";

    if (hasManutencaoPreventiva) return "Manutenção Preventiva";

    return "";
}

function applyGridFilterByTipo(tipoNome) {
    if (!gridApi) return;

    // toggle: se clicar de novo no mesmo tipo, limpa
    if (gridFilterState.mode === 'tipo' && gridFilterState.value === tipoNome) {
        gridFilterState.mode = null;
        gridFilterState.value = null;
        gridApi.setRowData(currentOpenTasks);

        // volta KPIs para o total geral
        updateKpisForSubset(currentOpenTasks);
        return;
    }

    var filtered = currentOpenTasks.filter(function (t) {
        return classifyTaskType(t) === tipoNome;
    });

    gridFilterState.mode = 'tipo';
    gridFilterState.value = tipoNome;

    gridApi.setRowData(filtered);

    // KPIs passam a mostrar só desse tipo
    updateKpisForSubset(filtered);
}

// =======================
// ATUALIZA SÓ OS KPIs (sem mexer nos gráficos)
// =======================
function updateKpisForSubset(tasks) {
    var kpiOpen = document.getElementById('kpi-abertos');
    var kpiTempo = document.getElementById('kpi-tempo-gasto');

    if (!kpiOpen || !kpiTempo) return;

    if (!tasks || !tasks.length) {
        kpiOpen.innerText = "0";
        kpiTempo.innerText = "00:00:00";
        return;
    }

    kpiOpen.innerText = tasks.length;

    var totalMin = tasks.reduce(function (acc, t) {
        return acc + (t.timeSpentInLogs || 0);
    }, 0);

    kpiTempo.innerText = formatMinutesToHHMMSS(totalMin);
}

// =======================
// DASHBOARD
// =======================
function formatMinutesToHHMMSS(totalMinutes) {
    var totalSeconds = Math.round(totalMinutes * 60);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    function pad(v) { return v < 10 ? "0" + v : "" + v; }
    return pad(hours) + ":" + pad(minutes) + ":" + seconds.toString().padStart(2, "0");
}

// =======================
// FILTRO DE ANO (NOVO) - Chamados por mês
// =======================
var selectedOpenYear = null;

function getAvailableOpenYears(tasks) {
    var yearsMap = {};
    (tasks || []).forEach(function (t) {
        if (typeof t.createdYear === 'number') yearsMap[t.createdYear] = true;
    });

    return Object.keys(yearsMap)
        .map(function (y) { return parseInt(y, 10); })
        .filter(function (y) { return !isNaN(y); })
        .sort(function (a, b) { return b - a; }); // desc
}

function pickDefaultYear(years) {
    var current = new Date().getFullYear();
    if (years.indexOf(current) !== -1) return current;
    return years.length ? years[0] : current;
}

function ensureOpenYearSelect(years) {
    var chartEl = document.getElementById('chart-open-by-month');
    if (!chartEl) return;

    var wrapperId = 'chart-open-by-month-year-wrapper';
    var selectId = 'chart-open-by-month-year';

    var wrapper = document.getElementById(wrapperId);
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = wrapperId;
        wrapper.style.display = 'flex';
        wrapper.style.justifyContent = 'flex-end';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '8px';
        wrapper.style.margin = '0 0 8px 0';

        var label = document.createElement('span');
        label.textContent = 'Ano:';

        var select = document.createElement('select');
        select.id = selectId;

        wrapper.appendChild(label);
        wrapper.appendChild(select);

        // insere o seletor acima do gráfico
        chartEl.parentNode.insertBefore(wrapper, chartEl);
    }

    var selectEl = document.getElementById(selectId);
    if (!selectEl) return;

    selectEl.innerHTML = '';
    years.forEach(function (y) {
        var opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        selectEl.appendChild(opt);
    });

    if (selectedOpenYear === null || years.indexOf(selectedOpenYear) === -1) {
        selectedOpenYear = pickDefaultYear(years);
    }
    selectEl.value = String(selectedOpenYear);

    if (!selectEl._boundChange) {
        selectEl.addEventListener('change', function () {
            selectedOpenYear = parseInt(this.value, 10);

            // se tinha filtro de mês aplicado, limpa (pra não “prender” o grid em outro ano)
            if (gridFilterState.mode === 'mes') {
                gridFilterState.mode = null;
                gridFilterState.value = null;
                if (gridApi) gridApi.setRowData(currentOpenTasks);
                updateKpisForSubset(currentOpenTasks);
            }

            // atualiza só o gráfico de mês (sem mexer nos outros)
            renderOpenByMonthChart(currentOpenTasks);
        });
        selectEl._boundChange = true;
    }
}

function renderOpenByMonthChart(openTasks) {
    if (!chartOpenByMonth) return;

    var years = getAvailableOpenYears(openTasks);
    ensureOpenYearSelect(years);

    if (!years.length) {
        chartOpenByMonth.clear();
        return;
    }

    var year = (typeof selectedOpenYear === 'number') ? selectedOpenYear : pickDefaultYear(years);

    // conta por mês (0..11) para o ANO selecionado
    var countsByIdx = new Array(12).fill(0);
    (openTasks || []).forEach(function (t) {
        if (t.createdYear === year && typeof t.createdMonth === 'number') {
            countsByIdx[t.createdMonth] += 1;
        }
    });

    var monthLabels = [];
    for (var m = 0; m < 12; m++) {
        monthLabels.push(
            normalizeMonthLabel(new Date(2000, m, 1).toLocaleString("pt-BR", { month: "short" }))
        );
    }

    // só mostra meses com valor > 0
    var months = [];
    var values = [];
    var monthIndexMap = [];

    for (var i = 0; i < 12; i++) {
        if (countsByIdx[i] > 0) {
            months.push(monthLabels[i]);
            values.push(countsByIdx[i]);
            monthIndexMap.push(i);
        }
    }

    var optionOpen = {
        grid: { left: 30, right: 10, top: 20, bottom: 30 },
        xAxis: { type: 'category', data: months },
        yAxis: { type: 'value' },
        series: [{
            type: 'bar',
            data: values,
            barWidth: '50%',
            itemStyle: { borderRadius: [4, 4, 0, 0] },
            label: {
                show: true,
                position: 'top',
                color: '#FFFFFF',
                fontSize: 14,
                fontWeight: 'normal',
                textBorderColor: '#000',
                textBorderWidth: 2
            }
        }]
    };

    chartOpenByMonth.setOption(optionOpen, true);

    // click no mês -> filtra grid (toggle)
    chartOpenByMonth.off('click');
    chartOpenByMonth.on('click', function (params) {
        if (!params) return;
        var idx = params.dataIndex;
        var monthIndex = monthIndexMap[idx];
        if (typeof monthIndex !== 'number') return;
        applyGridFilterByMonth(monthIndex); // agora respeita selectedOpenYear
    });
}

function updateDashboard(openTasks) {
    if (!openTasks || openTasks.length === 0) {
        if (document.getElementById('kpi-abertos')) {
            document.getElementById('kpi-abertos').innerText = "0";
            document.getElementById('kpi-tempo-gasto').innerText = "00:00:00";
        }
        if (chartOpenByMonth) chartOpenByMonth.clear();
        if (chartType) chartType.clear();
        if (chartResponsavel) chartResponsavel.clear();
        return;
    }

    // KPIs principais
    var kpiOpen = document.getElementById('kpi-abertos');
    if (kpiOpen) {
        kpiOpen.innerText = openTasks.length;
    }

    var totalMin = openTasks.reduce(function (acc, t) {
        return acc + (t.timeSpentInLogs || 0);
    }, 0);
    var kpiTempo = document.getElementById('kpi-tempo-gasto');
    if (kpiTempo) {
        kpiTempo.innerText = formatMinutesToHHMMSS(totalMin);
    }

    // =======================
    // Chamados por mês (ano atual) + CLICK para filtrar a lista
    // =======================
    // =======================

// Chamados por mês (COM FILTRO DE ANO)
// =======================
renderOpenByMonthChart(openTasks);


    // =======================
    // Tipo de Tarefa
    // =======================
    if (chartType) {
        var typeCounts = {
            "Projetos": 0,
            "Manutenção Preventiva": 0,
            "Contratos": 0,
            "Serviços": 0,
            "NOC": 0
        };

        openTasks.forEach(function (t) {
            var tipo = classifyTaskType(t);
            if (!tipo) return; // ignora BLANK()
            typeCounts[tipo] = (typeCounts[tipo] || 0) + 1;
        });

        var typeOrder = [
            "Projetos",
            "Manutenção Preventiva",
            "Contratos",
            "Serviços",
            "NOC"
        ];

        var typeNames = [];
        var typeValues = [];
        typeOrder.forEach(function (name) {
            if (typeCounts[name] && typeCounts[name] > 0) {
                typeNames.push(name);
                typeValues.push(typeCounts[name]);
            }
        });

        var optionType = {
            grid: { left: 80, right: 10, top: 10, bottom: 40 },
            xAxis: { type: 'value' },
            yAxis: { type: 'category', data: typeNames },
            series: [{
                type: 'bar',
                data: typeValues,
                barWidth: '40%',
                itemStyle: { borderRadius: [0, 4, 4, 0] },
                label: {
                    show: true,
                    position: 'right',
                    color: '#FFFFFF',
                    fontSize: 14,
                    fontWeight: 'normal',
                    textBorderColor: '#000',
                    textBorderWidth: 2
                }
            }]
        };
        chartType.setOption(optionType, true);

        chartType.off('click');
        chartType.on('click', function (params) {
            if (!params || !params.name) return;
            applyGridFilterByTipo(params.name);
        });
    }

    // =======================
    // Total em Aberto por Responsável
    // =======================
    if (chartResponsavel) {
        var respCounts = {};
        openTasks.forEach(function (t) {
            var resp = t.responsibleName || "Sem responsável";
            respCounts[resp] = (respCounts[resp] || 0) + 1;
        });

        var entries = Object.keys(respCounts).map(function (name) {
            return { name: name, value: respCounts[name] };
        });

        // ordena do maior para o menor
        entries.sort(function (a, b) { return b.value - a.value; });

        var respNames = entries.map(function (e) { return e.name; });
        var respValues = entries.map(function (e) { return e.value; });

        // define quantos responsáveis aparecem por vez no zoom
        var visibleCount = 8;
        var totalResp = Math.max(respNames.length, 1);
        var endPercent = Math.min(100, (visibleCount / totalResp) * 100);

        var optionResp = {
            grid: { left: 160, right: 30, top: 20, bottom: 40 },
            xAxis: { type: 'value' },
            yAxis: {
                type: 'category',
                data: respNames,
                axisLabel: {
                    fontSize: 11,
                    formatter: function (value) {
                        return value.length > 25 ? value.slice(0, 25) + '…' : value;
                    }
                }
            },
            dataZoom: [
                {
                    type: 'slider',
                    yAxisIndex: 0,
                    right: 0,
                    width: 16,
                    start: 0,
                    end: endPercent,
                    zoomLock: true,
                    moveHandleSize: 0,
                    handleSize: 0,
                    disabled: true
                },
                {
                    type: 'inside',
                    yAxisIndex: 0,
                    start: 0,
                    end: endPercent,
                    zoomOnMouseWheel: false,
                    moveOnMouseMove: false,
                    moveOnMouseWheel: false
                }
            ],
            series: [{
                type: 'bar',
                data: respValues,
                barWidth: '40%',
                itemStyle: { borderRadius: [0, 4, 4, 0] },
                label: {
                    show: true,
                    position: 'right',
                    color: '#FFFFFF',
                    fontSize: 14,
                    fontWeight: 'normal',
                    textBorderColor: '#000',
                    textBorderWidth: 2
                }
            }]
        };
        chartResponsavel.setOption(optionResp, true);

        chartResponsavel.off('click');
        chartResponsavel.on('click', function (params) {
            if (!params || !params.name) return;

            // filtra grid
            applyGridFilterByResponsavel(params.name);
            // abre painel de export com esse responsável pré-selecionado
            openExportPanelForResponsaveis([params.name]);
        });
    }
}

// =======================
// ABRIR EXPORT COM USUÁRIOS PRÉ-SELECIONADOS
// =======================
function openExportPanelForResponsaveis(responsaveis) {
    var panel = document.getElementById('export-panel');
    var backdrop = document.getElementById('export-backdrop');

    if (panel && backdrop) {
        panel.classList.add('open');
        backdrop.classList.add('show');
    }

    populateExportResponsavel(dataSourceTasks);

    var select = document.getElementById('export-responsavel');
    if (!select) return;

    for (var i = 0; i < select.options.length; i++) {
        select.options[i].selected = false;
    }

    if (!responsaveis || !responsaveis.length) return;

    responsaveis.forEach(function (nome) {
        for (var i = 0; i < select.options.length; i++) {
            var opt = select.options[i];
            if (opt.value === nome) {
                opt.selected = true;
                break;
            }
        }
    });
}

// =======================
// RESPONSÁVEL EXPORTAÇÃO
// =======================
function populateExportResponsavel(tasks) {
    var select = document.getElementById('export-responsavel');
    if (!select || !tasks || tasks.length === 0) return;

    // HTML: <select id="export-responsavel" multiple>...</select>
    select.innerHTML = '<option value="all">Todos</option>';

    var nomes = {};
    tasks.forEach(function (t) {
        if (isBlockedTask(t)) return;
        if (t.responsibleName) nomes[t.responsibleName] = true;
    });

    Object.keys(nomes).sort().forEach(function (nome) {
        var opt = document.createElement('option');
        opt.value = nome;
        opt.textContent = nome;
        select.appendChild(opt);
    });
}

// =======================
// HELPER BX24
// =======================
function send(method, parameters, callback) {
    console.log("send method", method);
    $("#loader-1").show();
    BX24.callMethod(method, parameters, function (result) {
        if (result.error()) {
            $("#loader-1").hide();
            alert('Erro na requisicao: ' + result.error());
        } else {
            console.log("send result.data()", result.data());
            var hasMore = result.more && result.more();
            callback(result, !hasMore);
            if (hasMore) {
                result.next();
            } else {
                $("#loader-1").hide();
            }
        }
    });
}

// Estado de la aplicación
let currentConversation = null;
let refreshInterval = null;
let conversationsCache = [];
let charts = {};
let selectedPeriod = '30d'; // Período por defecto

// Rastreo de conversaciones leídas (persistido en localStorage)
let seenConversations = JSON.parse(localStorage.getItem('seenConversations') || '{}');

function markConversationAsRead(phone, messageCount) {
    seenConversations[phone] = messageCount;
    localStorage.setItem('seenConversations', JSON.stringify(seenConversations));
}

function isConversationUnread(phone, messageCount) {
    const seen = seenConversations[phone];
    return seen === undefined || messageCount > seen;
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initDateSelector();
    loadAnalytics();
    loadConversations();
    loadAppointments();
    
    // Auto-refresh cada 10 segundos
    refreshInterval = setInterval(() => {
        const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');
        if (activeTab === 'analytics') {
            loadAnalytics();
        } else if (activeTab === 'conversations') {
            loadConversations();
            if (currentConversation) {
                loadConversationMessages(currentConversation);
            }
        } else if (activeTab === 'appointments') {
            loadAppointments();
        } else if (activeTab === 'pending-tasks') {
            loadPendingTasks();
        }
    }, 10000);
});

// Sistema de tabs
function initTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            
            // Remover active de todos
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Agregar active al seleccionado
            btn.classList.add('active');
            document.getElementById(targetTab).classList.add('active');
            
            // Detener auto-refresh de logs si se cambia de pestaña
            stopLogsAutoRefresh();
            
            // Cargar datos según el tab
            if (targetTab === 'analytics') {
                loadAnalytics();
            } else if (targetTab === 'conversations') {
                loadConversations();
            } else if (targetTab === 'appointments') {
                loadAppointments();
            } else if (targetTab === 'pending-tasks') {
                loadPendingTasks();
            } else if (targetTab === 'messages') {
                loadFAQs();
            } else if (targetTab === 'logs') {
                loadLogs();
                startLogsAutoRefresh();
            } else if (targetTab === 'config') {
                loadConfig();
            }
        });
    });
}

// Sistema de selector de fechas
function initDateSelector() {
    // Usar delegación de eventos en el contenedor para asegurar que funcione
    const dateSelector = document.querySelector('.date-selector');
    
    if (!dateSelector) {
        // Reintentar si no se encuentra
        setTimeout(initDateSelector, 100);
        return;
    }
    
    // Usar delegación de eventos - más confiable
    dateSelector.addEventListener('click', function(e) {
        // Verificar que el click fue en un botón de fecha
        const clickedBtn = e.target.closest('.date-btn');
        
        if (!clickedBtn) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const period = clickedBtn.getAttribute('data-period');
        
        // Remover active de todos los botones
        const allButtons = dateSelector.querySelectorAll('.date-btn');
        allButtons.forEach(btn => btn.classList.remove('active'));
        
        // Agregar active al botón clickeado
        clickedBtn.classList.add('active');
        
        // Actualizar el período seleccionado
        selectedPeriod = period;
        
        // Recargar analytics si estamos en esa pestaña
        const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');
        if (activeTab === 'analytics') {
            loadAnalytics();
        }
    });
    
    // Establecer período inicial
    const activeBtn = dateSelector.querySelector('.date-btn.active');
    if (activeBtn) {
        selectedPeriod = activeBtn.getAttribute('data-period') || '30d';
    }
}

// Cargar Analytics Dashboard
async function loadAnalytics() {
    // ── 1. Fetch de datos (errores de red / servidor) ────────────────────────
    let data;
    try {
        const url      = `/api/analytics?period=${selectedPeriod}`;
        const response = await fetch(url);

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Servidor respondió ${response.status}: ${body.slice(0, 120)}`);
        }

        data = await response.json();

        if (!data.usage || !data.performance || !data.conversion || !data.business) {
            throw new Error('La respuesta del servidor no tiene la estructura esperada.');
        }
    } catch (networkError) {
        console.error('Error de red al cargar analytics:', networkError);
        updateStatus(false);

        const insightsContainer = document.getElementById('ai-insights');
        if (insightsContainer) {
            insightsContainer.innerHTML = `
                <div class="insight-card" style="background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.4);">
                    <div class="insight-title">⚠️ Error de Conexión</div>
                    <div class="insight-text">No se pudo cargar los datos del servidor.<br><small style="opacity:0.7">${networkError.message}</small></div>
                </div>
            `;
        }
        return;
    }

    // ── 2. Renderizado de métricas (errores de JS en los charts, etc.) ───────
    updateStatus(true);

    try { updateUsageMetrics(data.usage); }
    catch (e) { console.error('Error renderizando métricas de uso:', e); }

    try { updatePerformanceMetrics(data.performance); }
    catch (e) { console.error('Error renderizando métricas de rendimiento:', e); }

    try { updateConversionMetrics(data.conversion); }
    catch (e) { console.error('Error renderizando métricas de conversión:', e); }

    try {
        if (data.business) {
            const appointmentsMainEl = document.getElementById('total-appointments-generated-kpi-main');
            if (appointmentsMainEl) appointmentsMainEl.textContent = data.business.totalAppointmentsGenerated || 0;
        }
    } catch (e) { console.error('Error renderizando métricas de negocio:', e); }

    try { generateAIInsights(data); }
    catch (e) {
        console.error('Error generando AI Insights:', e);
        const insightsContainer = document.getElementById('ai-insights');
        if (insightsContainer) {
            insightsContainer.innerHTML = `
                <div class="insight-card" style="background: rgba(234,179,8,0.15); border-color: rgba(234,179,8,0.4);">
                    <div class="insight-title">⚠️ Insights no disponibles</div>
                    <div class="insight-text">Hubo un error al generar los insights. Los datos se cargaron correctamente.<br><small style="opacity:0.7">${e.message}</small></div>
                </div>
            `;
        }
    }
}

// Actualizar métricas de uso
function updateUsageMetrics(usage) {
    if (!usage) return;
    
    // KPIs principales en la parte superior - solo los que vienen de usage
    const totalConvEl = document.getElementById('total-conversations-kpi');
    if (totalConvEl) totalConvEl.textContent = usage.totalConversations || 0;
    
    const newUsersEl = document.getElementById('new-users-kpi');
    if (newUsersEl) newUsersEl.textContent = usage.newUsers || 0;
    
    // NOTA: fcr-rate-kpi-main, avg-response-time-kpi-main y total-appointments-generated-kpi-main
    // se actualizan en updatePerformanceMetrics y updateBusinessMetrics respectivamente
    
    // KPIs secundarios (ocultos por ahora)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const todayCount = (usage.conversationsByDay || []).find(d => d.date === today)?.count || 0;
    const periodEl = document.getElementById('conversations-period');
    if (periodEl) periodEl.textContent = `${todayCount} hoy`;
    
    const returningEl = document.getElementById('returning-users-kpi');
    if (returningEl) returningEl.textContent = `${usage.returningUsers || 0} recurrentes`;
    
    const avgMsgEl = document.getElementById('avg-messages-kpi');
    if (avgMsgEl) avgMsgEl.textContent = usage.avgMessagesPerConversation?.toFixed(1) || '0';
    
    if (usage.peakHour) {
        const hour = usage.peakHour.time?.split('-')[1] || usage.peakHour.time || '-';
        const peakHourEl = document.getElementById('peak-hour-kpi');
        if (peakHourEl) peakHourEl.textContent = `${hour}:00`;
        const peakCountEl = document.getElementById('peak-hour-count');
        if (peakCountEl) peakCountEl.textContent = `${usage.peakHour.count || 0} mensajes`;
    }
    
    // Gráfico de conversaciones por día (solo nuevas)
    updateConversationsDayChart(usage.newConversationsByDay || usage.conversationsByDay || []);
    
    // Gráfico de estado de conversaciones
    updateConversationTypeChart(usage.etapaDistribution || null);
}

// Actualizar métricas de rendimiento
function updatePerformanceMetrics(performance) {
    if (!performance) return;
    
    // Actualizar KPIs principales en la parte superior
    const fcrMainEl = document.getElementById('fcr-rate-kpi-main');
    if (fcrMainEl) fcrMainEl.textContent = `${performance.fcrRate || 0}%`;
    
    const responseTimeMainEl = document.getElementById('avg-response-time-kpi-main');
    if (responseTimeMainEl) responseTimeMainEl.textContent = `${performance.avgResponseTime || 0}s`;
    
    // Actualizar displays en la sección de rendimiento
    const fcrDisplayEl = document.getElementById('fcr-rate-display');
    if (fcrDisplayEl) fcrDisplayEl.textContent = `${performance.fcrRate || 0}%`;
    
    const escalationDisplayEl = document.getElementById('escalation-rate-display');
    if (escalationDisplayEl) escalationDisplayEl.textContent = `${performance.escalationRate || 0}%`;
    
    const responseTimeDisplayEl = document.getElementById('avg-response-time-display');
    if (responseTimeDisplayEl) responseTimeDisplayEl.textContent = `${performance.avgResponseTime || 0}s`;
    
    const durationDisplayEl = document.getElementById('avg-conversation-duration-display');
    if (durationDisplayEl) {
        const minutes = Math.floor(performance.avgConversationDuration || 0);
        const seconds = Math.round((performance.avgConversationDuration || 0) % 1 * 60);
        durationDisplayEl.textContent = `${minutes}m ${seconds}s`;
    }
    
    // Calcular y mostrar cambios porcentuales vs periodo pasado
    // Escalamiento Humano: menos es mejor (↓ es bueno, ↑ es malo)
    const escalationChangeEl = document.getElementById('escalation-rate-change');
    if (escalationChangeEl) {
        const currentEscalation = performance.escalationRate || 0;
        const previousEscalation = performance.previousEscalationRate || (currentEscalation * 1.2); // Simulado si no hay dato
        const escalationChange = previousEscalation > 0 
            ? ((currentEscalation - previousEscalation) / previousEscalation * 100).toFixed(1)
            : 0;
        
        if (Math.abs(escalationChange) < 0.1) {
            escalationChangeEl.textContent = 'Sin cambio vs periodo pasado';
            escalationChangeEl.className = 'performance-subtitle';
        } else if (escalationChange < 0) {
            // Menos escalamiento = mejor
            escalationChangeEl.textContent = `↓ ${Math.abs(escalationChange)}% vs periodo pasado`;
            escalationChangeEl.className = 'performance-subtitle success';
        } else {
            // Más escalamiento = peor
            escalationChangeEl.textContent = `↑ ${escalationChange}% vs periodo pasado`;
            escalationChangeEl.className = 'performance-subtitle down';
        }
    }
    
    // Tiempo de Respuesta: menos es mejor (↓ es bueno, ↑ es malo)
    const responseTimeChangeEl = document.getElementById('response-time-change');
    if (responseTimeChangeEl) {
        const currentResponseTime = performance.avgResponseTime || 0;
        const previousResponseTime = performance.previousAvgResponseTime || (currentResponseTime * 1.15); // Simulado si no hay dato
        const responseTimeChange = previousResponseTime > 0
            ? ((currentResponseTime - previousResponseTime) / previousResponseTime * 100).toFixed(1)
            : 0;
        
        if (Math.abs(responseTimeChange) < 0.1) {
            responseTimeChangeEl.textContent = 'Sin cambio vs periodo pasado';
            responseTimeChangeEl.className = 'performance-subtitle';
        } else if (responseTimeChange < 0) {
            // Menos tiempo = mejor
            responseTimeChangeEl.textContent = `↓ ${Math.abs(responseTimeChange)}% vs periodo pasado`;
            responseTimeChangeEl.className = 'performance-subtitle success';
        } else {
            // Más tiempo = peor
            responseTimeChangeEl.textContent = `↑ ${responseTimeChange}% vs periodo pasado`;
            responseTimeChangeEl.className = 'performance-subtitle down';
        }
    }
    
    // También actualizar los KPIs secundarios si existen
    const fcrEl = document.getElementById('fcr-rate-kpi');
    if (fcrEl) fcrEl.textContent = `${performance.fcrRate || 0}%`;
    
    const escalationEl = document.getElementById('escalation-rate-kpi');
    if (escalationEl) escalationEl.textContent = `${performance.escalationRate || 0}%`;
    
    const responseTimeEl = document.getElementById('avg-response-time-kpi');
    if (responseTimeEl) responseTimeEl.textContent = `${performance.avgResponseTime || 0}s`;
    
    const durationEl = document.getElementById('avg-conversation-duration-kpi');
    if (durationEl) durationEl.textContent = `${performance.avgConversationDuration || 0} min`;
    
    // Gráfico de éxito en tareas
    updateTaskSuccessChart(performance.taskSuccess || {});
}

// Actualizar métricas de conversión
function updateConversionMetrics(conversion) {
    if (!conversion) return;
    
    const convRateEl = document.getElementById('conversion-rate-kpi');
    if (convRateEl) convRateEl.textContent = `${conversion.conversionRate || 0}%`;
    
    const confRateEl = document.getElementById('confirmation-rate-kpi');
    if (confRateEl) confRateEl.textContent = `${conversion.confirmationRate || 0}%`;
    
    const withApptEl = document.getElementById('conversations-with-appointment-kpi');
    if (withApptEl) withApptEl.textContent = conversion.conversationsWithAppointment || 0;
    
    const confirmedEl = document.getElementById('confirmed-appointments-kpi');
    if (confirmedEl) confirmedEl.textContent = conversion.confirmedAppointments || 0;
    
    // (funnel removido — ver AI Insights para tasa de agendado)
}

// Actualizar métricas de negocio
function updateBusinessMetrics(business) {
    if (!business) return;
    
    // Actualizar KPI principal en la parte superior
    const appointmentsMainEl = document.getElementById('total-appointments-generated-kpi-main');
    if (appointmentsMainEl) appointmentsMainEl.textContent = business.totalAppointmentsGenerated || 0;
    
    const totalApptEl = document.getElementById('total-appointments-generated-kpi');
    if (totalApptEl) totalApptEl.textContent = business.totalAppointmentsGenerated || 0;
    
    const cancelledEl = document.getElementById('appointments-cancelled-kpi');
    if (cancelledEl) cancelledEl.textContent = business.appointmentsCancelled || 0;
    
    const rescheduledEl = document.getElementById('appointments-rescheduled-kpi');
    if (rescheduledEl) rescheduledEl.textContent = business.appointmentsRescheduled || 0;
    
    if (business.peakAppointmentDay) {
        try {
            const date = new Date(business.peakAppointmentDay.date);
            const peakDayEl = document.getElementById('peak-appointment-day-kpi');
            if (peakDayEl) peakDayEl.textContent = date.toLocaleDateString('es-MX', { 
                weekday: 'short', 
                day: 'numeric', 
                month: 'short' 
            });
            const peakCountEl = document.getElementById('peak-appointment-day-count');
            if (peakCountEl) peakCountEl.textContent = `${business.peakAppointmentDay.count || 0} citas`;
        } catch (e) {
            console.error('Error formateando fecha de pico:', e);
        }
    }
    
    // Gráficos de citas
    updateAppointmentsDayChart(business.appointmentsByDay || []);
    updateAppointmentsHourChart(business.appointmentsByHour || []);
    
    // Gráficos de negocio y heatmap
    updateBusinessWeeklyChart(business);
    updateActivityHeatmap(business);
    
    // Actualizar métricas de negocio en la sección de Business Metrics
    const botApptEl = document.getElementById('business-appointments-bot');
    if (botApptEl) botApptEl.textContent = business.totalAppointmentsGenerated || 0;
    
    const cancelledBusinessEl = document.getElementById('business-cancelled');
    if (cancelledBusinessEl) cancelledBusinessEl.textContent = business.appointmentsCancelled || 0;
    
    const rescheduledBusinessEl = document.getElementById('business-rescheduled');
    if (rescheduledBusinessEl) rescheduledBusinessEl.textContent = business.appointmentsRescheduled || 0;
    
    // Calcular valor potencial (simulado: $250 por cita)
    const potentialValue = (business.totalAppointmentsGenerated || 0) * 250;
    const valueEl = document.getElementById('business-value');
    if (valueEl) valueEl.textContent = `$${potentialValue.toLocaleString('es-MX')}`;
}

// Gráfico de conversaciones por día
function updateConversationsDayChart(data) {
    const ctx = document.getElementById('conversations-day-chart');
    if (!ctx) return;
    
    const labels = data.map(d => {
        const date = new Date(d.date);
        return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    });
    const values = data.map(d => d.count);
    
    if (charts.conversationsDay) {
        charts.conversationsDay.destroy();
    }
    
    charts.conversationsDay = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Conversaciones Nuevas',
                data: values,
                borderColor: '#00f5ff',
                backgroundColor: 'rgba(0, 245, 255, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

// Gráfico de estado de conversaciones (doughnut)
// etapaDistribution: { primer_contacto: N, interesada: N, cita_agendada: N }
function updateConversationTypeChart(etapaDistribution) {
    const ctx = document.getElementById('conversation-type-chart');
    if (!ctx) return;

    const dist = etapaDistribution || { primer_contacto: 0, interesada: 0, cita_agendada: 0 };

    const labels = ['Primer contacto', 'Interesadas', 'Cita agendada'];
    const values = [
        dist.primer_contacto || 0,
        dist.interesada      || 0,
        dist.cita_agendada   || 0
    ];
    const total = values.reduce((a, b) => a + b, 0);

    // Si no hay sesiones todavía, mostrar placeholder visual equitativo
    const displayValues = total === 0 ? [1, 1, 1] : values;
    const colors = ['#00f5ff', '#ff6b35', '#00ff88'];

    if (charts.conversationType) {
        charts.conversationType.destroy();
    }

    charts.conversationType = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: displayValues,
                backgroundColor: colors,
                borderColor: 'rgba(0,0,0,0)',
                borderWidth: 0,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '62%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#94a3b8',
                        font: { size: 11 },
                        padding: 14,
                        boxWidth: 12,
                        boxHeight: 12
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (total === 0) return ' Sin sesiones aún';
                            const pct = ((context.parsed / total) * 100).toFixed(1);
                            return ` ${context.label}: ${context.parsed} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
}

// Gráfico de citas por día
function updateAppointmentsDayChart(data) {
    const ctx = document.getElementById('appointments-day-chart');
    if (!ctx) return;
    
    const labels = data.map(d => {
        const date = new Date(d.date);
        return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    });
    const values = data.map(d => d.count);
    
    if (charts.appointmentsDay) {
        charts.appointmentsDay.destroy();
    }
    
    charts.appointmentsDay = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Citas',
                data: values,
                borderColor: '#00ff88',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

// Gráfico de citas por hora
function updateAppointmentsHourChart(data) {
    const ctx = document.getElementById('appointments-hour-chart');
    if (!ctx) return;
    
    // Agrupar por hora del día
    const hourCounts = {};
    data.forEach(d => {
        const hour = d.time.split('-')[1] || d.time.split(':')[0] || '00';
        hourCounts[hour] = (hourCounts[hour] || 0) + d.count;
    });
    
    const labels = Object.keys(hourCounts).sort().map(h => `${h}:00`);
    const values = Object.keys(hourCounts).sort().map(h => hourCounts[h]);
    
    if (charts.appointmentsHour) {
        charts.appointmentsHour.destroy();
    }
    
    charts.appointmentsHour = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Citas',
                data: values,
                backgroundColor: '#14b8a6',
                borderColor: '#14b8a6',
                borderWidth: 0,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#94a3b8'
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#a0aec0',
                        stepSize: 1
                    }
                }
            }
        }
    });
}

// Gráfico semanal de citas (Bot vs. Humano)
function updateBusinessWeeklyChart(business) {
    const ctx = document.getElementById('business-weekly-chart');
    if (!ctx) return;
    
    // Simular datos semanales (en producción esto vendría del backend)
    const weeks = ['Sem 1', 'Sem 2', 'Sem 3', 'Sem 4'];
    const botData = [35, 45, 55, 55];
    const humanData = [10, 15, 10, 10];
    
    if (charts.businessWeekly) {
        charts.businessWeekly.destroy();
    }
    
    charts.businessWeekly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: weeks,
            datasets: [
                {
                    label: 'Citas generadas (AI Agent)',
                    data: botData,
                    backgroundColor: '#00f5ff',
                    borderColor: '#00f5ff',
                    borderWidth: 0,
                    borderRadius: 4
                },
                {
                    label: 'Reprogramadas',
                    data: humanData,
                    backgroundColor: '#ff6b35',
                    borderColor: '#ff6b35',
                    borderWidth: 0,
                    borderRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#94a3b8'
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#a0aec0',
                        stepSize: 15
                    }
                }
            }
        }
    });
}

// Heatmap de actividad
function updateActivityHeatmap(business) {
    const ctx = document.getElementById('activity-heatmap-chart');
    if (!ctx) return;
    
    // Simular datos de heatmap basados en conversaciones por hora/día
    // En producción esto vendría del backend con datos reales
    const days = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const hours = ['8am', '9am', '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm'];
    
    // Generar datos de intensidad para el heatmap
    // Más actividad en días laborales y horas pico
    const heatmapData = days.map((day, dayIdx) => {
        return hours.map((hour, hourIdx) => {
            let intensity = 0;
            if (dayIdx < 5) { // Lunes a Viernes
                if (hourIdx >= 1 && hourIdx <= 4) intensity = 0.8; // 9am-12pm
                else if (hourIdx >= 7 && hourIdx <= 9) intensity = 0.7; // 3pm-5pm
                else if (hourIdx === 0 || hourIdx === 5 || hourIdx === 6 || hourIdx === 10) intensity = 0.3; // Horas bajas
                else intensity = 0.5;
            } else { // Sábado y Domingo
                if (hourIdx >= 1 && hourIdx <= 4) intensity = 0.5;
                else if (hourIdx >= 7 && hourIdx <= 9) intensity = 0.4;
                else intensity = 0.2;
            }
            return intensity;
        });
    });
    
    if (charts.activityHeatmap) {
        charts.activityHeatmap.destroy();
    }
    
    // Crear un heatmap usando un gráfico de barras apiladas horizontal
    // Cada día es una fila, cada hora es una columna
    charts.activityHeatmap = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: hours,
            datasets: days.map((day, dayIdx) => ({
                label: day,
                data: heatmapData[dayIdx],
                backgroundColor: heatmapData[dayIdx].map(int => {
                    // Convertir intensidad a color teal con opacidad variable
                    const alpha = Math.max(0.15, Math.min(0.9, int));
                    return `rgba(0, 245, 255, ${alpha})`;
                }),
                borderColor: heatmapData[dayIdx].map(int => {
                    const alpha = Math.max(0.2, Math.min(1, int));
                    return `rgba(0, 245, 255, ${alpha})`;
                }),
                borderWidth: 1,
                borderRadius: 2
            }))
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: true,
                    position: 'right',
                    labels: {
                        color: '#a0aec0',
                        usePointStyle: true,
                        padding: 6,
                        font: {
                            size: 11
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const day = context.dataset.label;
                            const hour = context.label;
                            const intensity = context.parsed.x;
                            const percentage = Math.round(intensity * 100);
                            return `${day} ${hour}: ${percentage}% actividad`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    beginAtZero: true,
                    max: 1,
                    grid: {
                        display: false
                    },
                    ticks: {
                        display: false
                    }
                },
                y: {
                    stacked: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        display: true
                    },
                    ticks: {
                        color: '#a0aec0',
                        font: {
                            size: 11
                        }
                    }
                }
            }
        }
    });
}

// Generar AI Insights
function generateAIInsights(data) {
    const insights = [];

    // Insight 1: Tasa de agendado (conversaciones → cita)
    // Umbrales calibrados para boutique de vestidos de novia:
    //   >= 20% → Excelente   (1 de cada 5 convs resulta en cita)
    //   >= 8%  → Normal/esperado (industria promedio)
    //   < 8%   → Bajo — vale la pena revisar el flujo
    const convRate = data.conversion?.conversionRate || 0;
    let agendadoIcon, agendadoTitle, agendadoText;
    if (convRate >= 20) {
        agendadoIcon  = '🎯';
        agendadoTitle = 'Tasa de Agendado — Excelente';
        agendadoText  = `${convRate}% de las conversaciones terminan en una cita agendada. ¡Por encima del promedio!`;
    } else if (convRate >= 8) {
        agendadoIcon  = '📅';
        agendadoTitle = 'Tasa de Agendado — Normal';
        agendadoText  = `${convRate}% de las conversaciones terminan en una cita agendada. Rango esperado para el negocio.`;
    } else {
        agendadoIcon  = '⚠️';
        agendadoTitle = 'Tasa de Agendado — Baja';
        agendadoText  = `Solo ${convRate}% de conversaciones resultan en cita. Puede valer la pena revisar el flujo de agendamiento.`;
    }
    insights.push({ icon: agendadoIcon, title: agendadoTitle, text: agendadoText });

    // Insight 2: Horario con mayor tráfico
    // El hourKey del backend tiene formato "YYYY-MM-DD::HH" — extraer la parte
    // después de "::" para obtener la hora correcta en CDMX.
    if (data.usage?.peakHour) {
        const hourRaw = data.usage.peakHour.time || '';
        // Nuevo formato: "2026-04-17::14" → separar por "::"
        // Formato antiguo (fallback): "2026-04-17-14" → último segmento con "-"
        const hour = hourRaw.includes('::')
            ? hourRaw.split('::')[1]
            : hourRaw.split('-').pop();
        const count = data.usage.peakHour.count || 0;
        // Formatear como hora amigable: "14" → "2:00 pm", "09" → "9:00 am"
        const hourNum = parseInt(hour, 10);
        const hourLabel = isNaN(hourNum) ? `${hour}:00` :
            hourNum === 0  ? '12:00 am' :
            hourNum < 12   ? `${hourNum}:00 am` :
            hourNum === 12 ? '12:00 pm' :
                             `${hourNum - 12}:00 pm`;
        insights.push({
            icon: '🕐',
            title: 'Horario con Mayor Tráfico',
            text: `El pico de actividad ocurre a las ${hourLabel} con ${count} mensajes. Asegúrate de tener cobertura en ese horario.`
        });
    }

    // Mostrar insights
    const container = document.getElementById('ai-insights');
    if (!container) return;

    if (insights.length === 0) {
        container.innerHTML = '<p class="loading-text">No hay insights disponibles aún</p>';
        return;
    }

    container.innerHTML = insights.map(insight => `
        <div class="insight-card">
            <div class="insight-title">${insight.icon} ${insight.title}</div>
            <div class="insight-text">${insight.text}</div>
        </div>
    `).join('');
}

// Cargar conversaciones
async function loadConversations() {
    try {
        const response = await fetch('/api/conversations');
        const data = await response.json();

        const container = document.getElementById('conversations-list');

        if (data.conversations.length === 0) {
            container.innerHTML = '<p class="loading-text">No hay conversaciones</p>';
            return;
        }

        conversationsCache = data.conversations;

        // Preservar posición de scroll para que no salte al hacer refresh
        const scrollTop = container.scrollTop;

        // Agrupar conversaciones por día
        const todayStr   = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
        const yesterday  = new Date(Date.now() - 864e5).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });

        const groups = {};
        data.conversations.forEach(conv => {
            const d = conv.lastActivity
                ? new Date(conv.lastActivity).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
                : 'Sin fecha';
            if (!groups[d]) groups[d] = [];
            groups[d].push(conv);
        });

        const dayLabel = d => {
            if (d === todayStr)  return 'Hoy';
            if (d === yesterday) return 'Ayer';
            // Format: "lunes 14 de abril"
            const parts = d.split('/'); // d/m/yyyy
            if (parts.length === 3) {
                const dt = new Date(+parts[2], +parts[1]-1, +parts[0]);
                return dt.toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long', timeZone:'America/Mexico_City' });
            }
            return d;
        };

        const renderConvItem = conv => {
            const isActive = conv.phone === currentConversation;
            const unread   = !isActive && isConversationUnread(conv.phone, conv.messageCount);
            const paused   = conv.botPaused;
            const pauseBg    = paused ? '#2d6a4f' : '#ff6b35';
            const pauseTitle = paused ? 'Bot pausado — clic para reanudar' : 'Pausar bot 10 min';
            const btnId      = `pause-btn-${conv.phone.replace(/\D/g,'')}`;
            const pausedUntilAttr = paused && conv.pausedUntil ? `data-paused-until="${conv.pausedUntil}"` : '';
            return `
                <div class="conversation-item ${isActive ? 'active' : ''}"
                     data-phone="${conv.phone}"
                     onclick="selectConversation('${conv.phone}')">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                        <div style="min-width:0;">
                            <div style="display:flex;align-items:center;gap:6px;">
                                <div class="conversation-phone">${formatPhone(conv.phone)}</div>
                                ${unread ? '<span class="unread-dot" title="Mensajes sin leer"></span>' : ''}
                            </div>
                            ${conv.nombre ? `<div style="font-weight:600;color:#667eea;font-size:12px;">${escapeHtml(conv.nombre)}</div>` : ''}
                        </div>
                        <button id="${btnId}" title="${pauseTitle}" ${pausedUntilAttr}
                            onclick="event.stopPropagation();togglePauseConversation('${conv.phone}',${paused})"
                            style="flex-shrink:0;padding:4px 8px;background:${pauseBg};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;">
                            ${paused ? '▶ Reanudar' : '⏸ Pausar'}
                        </button>
                    </div>
                    <div class="conversation-preview">${escapeHtml(conv.lastMessage?.message || 'Sin mensajes')}</div>
                </div>`;
        };

        container.innerHTML = Object.entries(groups).map(([day, convs], idx) => {
            const label    = dayLabel(day);
            const isToday  = day === todayStr;
            const groupId  = `conv-group-${idx}`;
            const open     = isToday ? 'open' : '';
            const arrow    = isToday ? '▾' : '▸';
            return `
                <details class="conv-day-group" ${open} id="${groupId}">
                    <summary onclick="toggleDayArrow('${groupId}')"
                        style="list-style:none;display:flex;justify-content:space-between;align-items:center;
                               padding:7px 10px;cursor:pointer;user-select:none;
                               background:rgba(255,255,255,0.04);border-radius:8px;margin-bottom:2px;
                               font-size:12px;font-weight:600;color:#94a3b8;letter-spacing:.3px;">
                        <span><span class="day-arrow" style="margin-right:5px;">${arrow}</span>${label}</span>
                        <span style="background:rgba(255,255,255,0.08);border-radius:10px;padding:1px 7px;font-size:11px;">${convs.length}</span>
                    </summary>
                    ${convs.map(renderConvItem).join('')}
                </details>`;
        }).join('');

        // Restaurar posición de scroll
        container.scrollTop = scrollTop;

        // Iniciar countdown en botones pausados
        startPauseCountdowns();
    } catch (error) {
        console.error('Error cargando conversaciones:', error);
    }
}

// Countdown en botones de pausa
let _pauseCountdownInterval = null;
function startPauseCountdowns() {
    if (_pauseCountdownInterval) clearInterval(_pauseCountdownInterval);
    function tick() {
        const btns = document.querySelectorAll('[data-paused-until]');
        if (btns.length === 0) { clearInterval(_pauseCountdownInterval); _pauseCountdownInterval = null; return; }
        btns.forEach(btn => {
            const until = new Date(btn.dataset.pausedUntil);
            const secsLeft = Math.max(0, Math.floor((until - Date.now()) / 1000));
            const mm = String(Math.floor(secsLeft / 60)).padStart(2, '0');
            const ss = String(secsLeft % 60).padStart(2, '0');
            btn.textContent = secsLeft > 0 ? `▶ Reanudar (${mm}:${ss})` : '▶ Reanudar';
        });
    }
    tick();
    _pauseCountdownInterval = setInterval(tick, 1000);
}

// Actualizar flecha de grupo colapsable al hacer toggle
function toggleDayArrow(groupId) {
    const details = document.getElementById(groupId);
    if (!details) return;
    const arrow = details.querySelector('.day-arrow');
    if (!arrow) return;
    // El estado open aún NO cambió en el momento del onclick, así que invertimos
    arrow.textContent = details.open ? '▸' : '▾';
}

// Seleccionar conversación
async function selectConversation(phone) {
    currentConversation = phone;

    // Actualizar clase active en el DOM sin re-renderizar toda la lista
    document.querySelectorAll('.conversation-item').forEach(item => {
        const isSelected = item.dataset.phone === phone;
        item.classList.toggle('active', isSelected);
        // Quitar el indicador de no leído al seleccionar
        if (isSelected) {
            item.querySelector('.unread-dot')?.remove();
        }
    });

    loadConversationMessages(phone);
}

// Cargar mensajes de una conversación
async function loadConversationMessages(phone) {
    try {
        const response = await fetch(`/api/conversations/${phone}`);
        const data = await response.json();

        // Marcar conversación como leída
        markConversationAsRead(phone, data.messages.length);

        const header = document.getElementById('conversation-header');
        const messagesContainer = document.getElementById('conversation-messages');

        header.innerHTML = `<h3>Conversación con ${formatPhone(phone)}</h3><p>${data.messages.length} mensajes</p>`;

        if (data.messages.length === 0) {
            messagesContainer.innerHTML = '<p class="loading-text">No hay mensajes en esta conversación</p>';
            return;
        }

        messagesContainer.innerHTML = data.messages.map(msg => {
            if (msg.direction === 'system') {
                return `<div style="display:flex;align-items:center;gap:8px;margin:10px 0;">
                    <div style="flex:1;height:1px;background:#e0e0e0;"></div>
                    <div style="font-size:11px;color:#888;background:#f0f0f0;padding:3px 10px;border-radius:12px;white-space:nowrap;">${escapeHtml(msg.message)} · ${formatDate(msg.timestamp)}</div>
                    <div style="flex:1;height:1px;background:#e0e0e0;"></div>
                </div>`;
            }
            return `<div class="conversation-message ${msg.direction}">
                <div>${escapeHtml(msg.message)}</div>
                <div class="message-time">${formatDate(msg.timestamp)}</div>
            </div>`;
        }).join('');

        // Scroll al final
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } catch (error) {
        console.error('Error cargando mensajes:', error);
    }
}

// Pausar / reanudar bot para una conversación específica
async function togglePauseConversation(phone, currentlyPaused) {
    try {
        if (currentlyPaused) {
            await fetch('/admin/resume-bot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone })
            });
        } else {
            await fetch('/admin/pause-bot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, minutes: 40 })
            });
        }
        // Refrescar la lista para reflejar el nuevo estado
        loadConversations();
    } catch (err) {
        console.error('Error al cambiar pausa:', err);
    }
}

// Cargar citas — ordenadas por fecha en que se agendaron (más reciente arriba),
// agrupadas por día de agendamiento igual que la lista de conversaciones.
async function loadAppointments() {
    try {
        const response = await fetch('/api/appointments');
        const data = await response.json();

        const container = document.getElementById('appointments-list');

        if (!data.appointments || data.appointments.length === 0) {
            container.innerHTML = '<p class="loading-text">No hay citas agendadas</p>';
            return;
        }

        // ── Agrupar por día de agendamiento ───────────────────────────────────
        const todayStr     = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
        const yesterdayStr = new Date(Date.now() - 864e5).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });

        const groups = {};
        data.appointments.forEach(apt => {
            const d = apt.agendadaEn
                ? new Date(apt.agendadaEn).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
                : 'Sin fecha';
            if (!groups[d]) groups[d] = [];
            groups[d].push(apt);
        });

        const dayLabel = d => {
            if (d === todayStr)     return 'Hoy';
            if (d === yesterdayStr) return 'Ayer';
            const parts = d.split('/'); // d/m/yyyy
            if (parts.length === 3) {
                const dt = new Date(+parts[2], +parts[1] - 1, +parts[0]);
                return dt.toLocaleDateString('es-MX', {
                    weekday: 'long', day: 'numeric', month: 'long',
                    timeZone: 'America/Mexico_City'
                });
            }
            return d;
        };

        const aptCard = apt => `
            <div class="appointment-card">
                <div class="appointment-info">
                    <h3>${escapeHtml(apt.name || 'Sin nombre')}</h3>
                    <p>📞 ${formatPhone(apt.phone)}</p>
                    ${apt.fechaBoda ? `<p>💒 Boda: ${escapeHtml(apt.fechaBoda)}</p>` : ''}
                    <p style="font-size:11px;color:#adb5bd;margin-top:4px;">
                        Agendada: ${apt.agendadaEn
                            ? new Date(apt.agendadaEn).toLocaleTimeString('es-MX',
                                { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })
                            : '—'}
                    </p>
                </div>
                <div class="appointment-date">
                    ${apt.fechaCita
                        ? `<div style="font-size:17px;font-weight:600;color:#667eea;margin-bottom:4px;">${formatAppointmentDate(apt.fechaCita)}</div>`
                        : '<div style="font-size:13px;color:#6c757d;">Fecha no especificada</div>'}
                </div>
            </div>`;

        // Renderizar grupos — mismo patrón <details> colapsable que conversaciones
        container.innerHTML = Object.entries(groups).map(([day, apts], idx) => {
            const label   = dayLabel(day);
            const isToday = day === todayStr;
            const groupId = `apt-group-${idx}`;
            const open    = isToday ? 'open' : '';
            const arrow   = isToday ? '▾' : '▸';
            return `
                <details class="conv-day-group" ${open} id="${groupId}">
                    <summary onclick="toggleDayArrow('${groupId}')"
                        style="list-style:none;display:flex;justify-content:space-between;align-items:center;
                               padding:7px 10px;cursor:pointer;user-select:none;
                               background:rgba(255,255,255,0.04);border-radius:8px;margin-bottom:2px;
                               font-size:12px;font-weight:600;color:#94a3b8;letter-spacing:.3px;">
                        <span><span class="day-arrow" style="margin-right:5px;">${arrow}</span>${label}</span>
                        <span style="background:rgba(255,255,255,0.08);border-radius:10px;padding:1px 7px;font-size:11px;">${apts.length}</span>
                    </summary>
                    ${apts.map(aptCard).join('')}
                </details>`;
        }).join('');

    } catch (error) {
        console.error('Error cargando citas:', error);
    }
}

// Almacén de tareas cargadas (para descarga Excel sin re-fetch)
let _pendingTasksData = [];

// Cargar tareas pendientes
async function loadPendingTasks() {
    const container = document.getElementById('pending-tasks-list');
    const toolbar = document.getElementById('tasks-toolbar');
    if (!container) return;
    container.innerHTML = '<p class="loading-text">Cargando tareas...</p>';

    try {
        const response = await fetch('/api/pending-tasks');
        const data = await response.json();

        _pendingTasksData = data.tasks || [];

        if (_pendingTasksData.length === 0) {
            if (toolbar) toolbar.style.display = 'none';
            container.innerHTML = '<p class="loading-text" style="color:#28a745;">✅ No hay tareas pendientes</p>';
            return;
        }

        if (toolbar) toolbar.style.display = 'flex';

        // Reset select-all checkbox
        const selectAll = document.getElementById('select-all-tasks');
        if (selectAll) selectAll.checked = false;
        _updateTasksSelectedCount();

        container.innerHTML = _pendingTasksData.map(task => `
            <div class="appointment-card" id="task-row-${task.id}" style="border-left: 4px solid #dc3545;">
                <div style="display:flex; align-items:center; padding-right:12px;">
                    <input type="checkbox" class="task-checkbox" data-id="${task.id}" onchange="_updateTasksSelectedCount()" style="width:16px; height:16px; cursor:pointer;">
                </div>
                <div class="appointment-info" style="flex:1;">
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
                        <span style="font-weight:700; font-size:15px;">${escapeHtml(task.nombre || 'Sin nombre')}</span>
                        <span style="font-size:12px; color:#6c757d; background:#f8f9fa; padding:2px 8px; border-radius:12px;">📞 ${escapeHtml(task.telefono)}</span>
                    </div>
                    <p style="margin:0 0 6px 0; font-size:14px; color:var(--text-primary);">💬 <strong>Último mensaje:</strong> ${escapeHtml(task.ultimoMensaje)}</p>
                    ${task.contexto ? `<p style="margin:0 0 6px 0; font-size:12px; color:var(--text-secondary); background:var(--bg-secondary); padding:6px 10px; border-radius:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%;" title="${escapeHtml(task.contexto)}">🗂 ${escapeHtml(task.contexto.substring(0, 150))}${task.contexto.length > 150 ? '…' : ''}</p>` : ''}
                    <p style="margin:0; font-size:12px; color:var(--text-light);">🕐 ${escapeHtml(task.fecha)} a las ${escapeHtml(task.hora)}</p>
                </div>
                <div style="display:flex; align-items:center; padding-left:16px;">
                    <button onclick="resolvePendingTask(${task.id})" style="padding:8px 16px; background:#28a745; color:#fff; border:none; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600; white-space:nowrap;">
                        ✅ Resolver
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error cargando tareas pendientes:', error);
        container.innerHTML = '<p class="loading-text" style="color:#dc3545;">Error al cargar tareas pendientes</p>';
    }
}

function _updateTasksSelectedCount() {
    const checkboxes = document.querySelectorAll('.task-checkbox');
    const checked = document.querySelectorAll('.task-checkbox:checked');
    const countEl = document.getElementById('tasks-selected-count');
    const selectAll = document.getElementById('select-all-tasks');
    const btnDelete = document.getElementById('btn-delete-selected');

    if (countEl) {
        countEl.textContent = checked.length > 0 ? `${checked.length} de ${checkboxes.length} seleccionadas` : '';
    }
    if (selectAll) {
        selectAll.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
        selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
    }
    if (btnDelete) {
        btnDelete.disabled = checked.length === 0;
        btnDelete.style.opacity = checked.length === 0 ? '0.5' : '1';
    }
}

function toggleSelectAllTasks(checked) {
    document.querySelectorAll('.task-checkbox').forEach(cb => { cb.checked = checked; });
    _updateTasksSelectedCount();
}

function downloadTasksExcel() {
    if (_pendingTasksData.length === 0) return;

    // ── Datos ──────────────────────────────────────────────────────────────────
    const headers = ['ID', 'Fecha', 'Hora', 'Nombre', 'Teléfono', 'Último Mensaje', 'Contexto', 'Estado'];
    const rows = _pendingTasksData.map(t => [
        t.id,
        t.fecha,
        t.hora,
        t.nombre || '',
        t.telefono,
        t.ultimoMensaje,
        t.contexto || '',
        t.estado
    ]);

    // ── Crear workbook con SheetJS ─────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    const wsData = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Ancho de columnas (en caracteres)
    ws['!cols'] = [
        { wch: 5  },  // ID
        { wch: 12 },  // Fecha
        { wch: 8  },  // Hora
        { wch: 22 },  // Nombre
        { wch: 16 },  // Teléfono
        { wch: 45 },  // Último Mensaje
        { wch: 50 },  // Contexto
        { wch: 12 },  // Estado
    ];

    // Estilo de encabezado (fondo oscuro, texto blanco, negrita)
    const headerStyle = {
        font:      { bold: true, color: { rgb: 'FFFFFF' } },
        fill:      { fgColor: { rgb: '1E3A5F' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: false },
        border: {
            bottom: { style: 'thin', color: { rgb: 'FFFFFF' } }
        }
    };
    headers.forEach((_, col) => {
        const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
        if (ws[cellRef]) ws[cellRef].s = headerStyle;
    });

    // Estilo de filas de datos (zebra: blanco / gris muy claro)
    const rowStyle      = { alignment: { vertical: 'top', wrapText: true } };
    const rowStyleAlt   = { fill: { fgColor: { rgb: 'F1F5F9' } }, alignment: { vertical: 'top', wrapText: true } };
    rows.forEach((_, r) => {
        headers.forEach((__, c) => {
            const cellRef = XLSX.utils.encode_cell({ r: r + 1, c });
            if (ws[cellRef]) ws[cellRef].s = (r % 2 === 0) ? rowStyle : rowStyleAlt;
        });
    });

    XLSX.utils.book_append_sheet(wb, ws, 'Tareas Pendientes');

    // ── Descargar ──────────────────────────────────────────────────────────────
    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `tareas-pendientes-${fecha}.xlsx`);
}

async function deleteSelectedTasks() {
    const checked = document.querySelectorAll('.task-checkbox:checked');
    if (checked.length === 0) return;

    const ids = Array.from(checked).map(cb => parseInt(cb.dataset.id));
    const confirmMsg = ids.length === _pendingTasksData.length
        ? `¿Eliminar todas las ${ids.length} tareas pendientes?`
        : `¿Eliminar las ${ids.length} tareas seleccionadas?`;

    if (!confirm(confirmMsg)) return;

    const btnDelete = document.getElementById('btn-delete-selected');
    if (btnDelete) { btnDelete.disabled = true; btnDelete.textContent = 'Eliminando...'; }

    try {
        const response = await fetch('/api/pending-tasks', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        if (!response.ok) throw new Error('Error del servidor');
        await loadPendingTasks();
    } catch (error) {
        console.error('Error eliminando tareas:', error);
        alert('Error al eliminar las tareas. Intenta de nuevo.');
        if (btnDelete) { btnDelete.disabled = false; btnDelete.textContent = '🗑 Eliminar seleccionadas'; }
    }
}

async function resolvePendingTask(id) {
    const card = document.getElementById(`task-row-${id}`);
    if (card) {
        card.style.opacity = '0.5';
        card.style.pointerEvents = 'none';
    }

    try {
        const response = await fetch(`/api/pending-tasks/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Error del servidor');
        await loadPendingTasks();
    } catch (error) {
        console.error('Error resolviendo tarea:', error);
        if (card) { card.style.opacity = '1'; card.style.pointerEvents = ''; }
        alert('Error al resolver la tarea. Intenta de nuevo.');
    }
}

// Cargar configuración
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        
        document.getElementById('business-name').value = data.business?.nombre || '';
        document.getElementById('business-address').value = data.business?.direccion || '';
        document.getElementById('admin-phone').value = data.adminPhone || '';
        document.getElementById('bot-phone').value = data.botPhone || '';
        document.getElementById('horarios-martes-sabado').value = data.horarios?.martes_sabado || '';
        document.getElementById('horarios-domingos').value = data.horarios?.domingos || '';
        document.getElementById('catalogo-link').value = data.catalogo?.link || '';
        document.getElementById('precio-base').value = data.precios?.precio_base || '';
        document.getElementById('staff-phones').value = (data.staffPhones || []).join('\n');
    } catch (error) {
        console.error('Error cargando configuración:', error);
    }
    
    // Cargar estado del bot (unificado)
    loadBotMode();
}

// Cargar estado del bot (unificado: inactive, test, active)
async function loadBotMode() {
    try {
        const response = await fetch('/api/bot-mode');
        const data = await response.json();
        updateBotModeUI(data.mode || 'inactive');
    } catch (error) {
        console.error('Error cargando estado del bot:', error);
        updateBotModeUI('inactive'); // Por defecto inactivo si hay error (seguridad)
    }
}

// Actualizar UI del estado del bot (unificado)
function updateBotModeUI(mode) {
    const statusText = document.getElementById('bot-mode-status-text');
    const statusIndicator = document.getElementById('bot-mode-status-indicator');
    const statusBadge = document.getElementById('bot-mode-status-badge');
    
    const modeConfig = {
        'inactive': {
            text: 'Bot inactivo - No responderá a ningún mensaje',
            color: '#ff4444',
            shadow: 'rgba(255, 68, 68, 0.5)',
            badge: 'INACTIVO',
            badgeColor: '#ff4444'
        },
        'test': {
            text: 'Modo de pruebas - Solo responderá a +525521920710',
            color: '#ffb800',
            shadow: 'rgba(255, 184, 0, 0.5)',
            badge: 'PRUEBAS',
            badgeColor: '#ffb800'
        },
        'active': {
            text: 'Bot activo - Responderá a todos los números',
            color: '#00ff88',
            shadow: 'rgba(0, 255, 136, 0.5)',
            badge: 'ACTIVO',
            badgeColor: '#00ff88'
        }
    };
    
    const config = modeConfig[mode] || modeConfig['active'];
    
    if (statusText) {
        statusText.textContent = config.text;
    }
    
    if (statusIndicator) {
        statusIndicator.style.background = config.color;
        statusIndicator.style.boxShadow = `0 0 10px ${config.shadow}`;
    }
    
    if (statusBadge) {
        statusBadge.textContent = config.badge;
        statusBadge.style.color = config.badgeColor;
    }
    
    // Actualizar botones - marcar el activo
    const modeButtons = document.querySelectorAll('.bot-mode-btn');
    modeButtons.forEach(btn => {
        const btnMode = btn.dataset.mode;
        if (btnMode === mode) {
            // Botón activo
            btn.style.border = `2px solid ${config.color}`;
            btn.style.background = `${config.color}15`;
            btn.style.transform = 'scale(1.05)';
            btn.style.boxShadow = `0 0 15px ${config.shadow}`;
        } else {
            // Botones inactivos
            btn.style.border = '2px solid var(--border-color)';
            btn.style.background = 'var(--bg-secondary)';
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = 'none';
        }
    });
}

// Cambiar estado del bot a un modo específico
async function setBotMode(mode) {
    try {
        const updateResponse = await fetch('/api/bot-mode', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ mode })
        });
        
        if (!updateResponse.ok) {
            throw new Error('Error al actualizar el estado del bot');
        }
        
        const result = await updateResponse.json();
        updateBotModeUI(mode);
        
        // Mostrar mensaje de confirmación
        const statusMessage = document.getElementById('bot-mode-status-message');
        if (statusMessage) {
            statusMessage.style.display = 'block';
            statusMessage.className = 'status-message success';
            statusMessage.textContent = result.message || `Estado actualizado a: ${mode}`;
            
            setTimeout(() => {
                statusMessage.style.display = 'none';
            }, 3000);
        }
    } catch (error) {
        console.error('Error cambiando estado del bot:', error);
        const statusMessage = document.getElementById('bot-mode-status-message');
        if (statusMessage) {
            statusMessage.style.display = 'block';
            statusMessage.className = 'status-message error';
            statusMessage.textContent = 'Error al cambiar el estado del bot';
        }
    }
}

// Event listeners para los botones de modo
document.addEventListener('DOMContentLoaded', () => {
    const modeButtons = document.querySelectorAll('.bot-mode-btn');
    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode) {
                setBotMode(mode);
            }
        });
    });
    
    // Event listeners para logs
    const logLevelFilter = document.getElementById('log-level-filter');
    const refreshLogsBtn = document.getElementById('refresh-logs-btn');
    
    if (logLevelFilter) {
        logLevelFilter.addEventListener('change', loadLogs);
    }
    if (refreshLogsBtn) {
        refreshLogsBtn.addEventListener('click', loadLogs);
    }
});

// Cargar logs
let logsRefreshInterval = null;

async function loadLogs() {
    try {
        const levelFilter = document.getElementById('log-level-filter')?.value || 'all';
        const response = await fetch(`/api/logs?limit=500&level=${levelFilter}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        const container = document.getElementById('logs-container');
        if (!container) {
            console.error('Container de logs no encontrado');
            return;
        }
        
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = `<div class="loading-text">No hay logs disponibles (Total en buffer: ${data.total || 0})</div>`;
            return;
        }
        
        // Ordenar logs por timestamp (más recientes primero)
        const sortedLogs = [...data.logs].reverse();
        
        // Guardar posición del scroll antes de actualizar
        const scrollPosition = container.scrollTop;
        const wasAtTop = scrollPosition < 50; // Considerar "arriba" si está a menos de 50px del inicio
        const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
        
        container.innerHTML = sortedLogs.map(log => {
            const date = new Date(log.timestamp);
            const timeStr = date.toLocaleString('es-MX', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            const levelClass = `log-${log.level}`;
            const levelIcon = log.level === 'error' ? '❌' : log.level === 'warn' ? '⚠️' : 'ℹ️';
            
            return `
                <div class="log-entry ${levelClass}">
                    <div class="log-timestamp">${timeStr}</div>
                    <div class="log-level">${levelIcon} ${log.level.toUpperCase()}</div>
                    <div class="log-message">${escapeHtml(log.message)}</div>
                </div>
            `;
        }).join('');
        
        // Restaurar posición del scroll
        // Solo hacer scroll al inicio si el usuario estaba en la parte superior
        // Si estaba scrolleando, mantener su posición relativa
        if (wasAtTop) {
            container.scrollTop = 0;
        } else if (wasAtBottom) {
            // Si estaba al final, mantener al final (para ver nuevos logs)
            container.scrollTop = container.scrollHeight;
        } else {
            // Mantener posición relativa aproximada
            const newScrollHeight = container.scrollHeight;
            const ratio = scrollPosition / (container.scrollHeight - container.clientHeight);
            container.scrollTop = Math.max(0, (newScrollHeight - container.clientHeight) * ratio);
        }
        
    } catch (error) {
        console.error('Error cargando logs:', error);
        const container = document.getElementById('logs-container');
        if (container) {
            container.innerHTML = `<div class="error-text">Error cargando logs: ${error.message}</div>`;
        }
    }
}

// Auto-refresh logs cada 3 segundos cuando la pestaña está activa
function startLogsAutoRefresh() {
    if (logsRefreshInterval) {
        clearInterval(logsRefreshInterval);
    }
    
    const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');
    if (activeTab === 'logs') {
        logsRefreshInterval = setInterval(loadLogs, 3000);
    }
}

// Detener auto-refresh cuando se cambia de pestaña
function stopLogsAutoRefresh() {
    if (logsRefreshInterval) {
        clearInterval(logsRefreshInterval);
        logsRefreshInterval = null;
    }
}

// Cargar y mostrar FAQs del Help Center
async function loadFAQs() {
    const container = document.getElementById('faqs-container');
    if (!container) return;

    try {
        const response = await fetch('/api/faqs');
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const faqs = await response.json();

        // Group by category
        const categories = {};
        faqs.forEach(faq => {
            const cat = faq.categoria || 'General';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(faq);
        });

        container.innerHTML = '';

        const categoryIcons = {
            'Cita': '📅',
            'Ubicación': '📍',
            'Pagos': '💳',
            'Vestidos': '👗',
            'Precios': '💰',
            'General': '💬'
        };

        Object.entries(categories).forEach(([cat, items]) => {
            const icon = categoryIcons[cat] || '❓';
            const card = document.createElement('div');
            card.className = 'flow-card';
            card.innerHTML = `
                <div class="flow-header">
                    <h3>${icon} ${cat}</h3>
                </div>
                <div class="faqs-list">
                    ${items.map(faq => `
                        <div class="faq-card">
                            <div class="faq-question">❓ ${escapeHtml(faq.pregunta)}</div>
                            <div class="faq-answer">${escapeHtml(faq.respuesta).replace(/\n/g, '<br>')}</div>
                        </div>
                    `).join('')}
                </div>
            `;
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error cargando FAQs:', error);
        container.innerHTML = `<p class="loading-text" style="color: var(--danger-color);">Error cargando FAQs: ${error.message}</p>`;
    }
}

// Cargar mensajes del bot
let messagesData = {};

async function loadMessages() {
    try {
        const response = await fetch('/api/messages');
        
        // Verificar que la respuesta sea JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.error('❌ Respuesta no es JSON:', text.substring(0, 200));
            throw new Error(`El servidor devolvió ${contentType} en lugar de JSON. ¿El servidor está corriendo?`);
        }
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
        
        messagesData = await response.json();
        
        const container = document.getElementById('messages-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        // Crear interfaz para cada flujo
        Object.entries(messagesData).forEach(([flowKey, flowData]) => {
            const flowCard = document.createElement('div');
            flowCard.className = 'flow-card';
            
            flowCard.innerHTML = `
                <div class="flow-header">
                    <h3>${flowData.nombre}</h3>
                    <p class="flow-description">${flowData.descripcion}</p>
                </div>
                <div class="messages-list" id="messages-${flowKey}">
                </div>
            `;
            
            container.appendChild(flowCard);
            
            // Agregar cada mensaje del flujo
            const messagesList = document.getElementById(`messages-${flowKey}`);
            Object.entries(flowData.mensajes).forEach(([msgKey, msgData]) => {
                const messageCard = document.createElement('div');
                messageCard.className = 'message-card';
                
                const variablesList = msgData.variables && msgData.variables.length > 0
                    ? `<div class="variables-info">
                        <strong>Variables disponibles:</strong> ${msgData.variables.map(v => `<code>{${v}}</code>`).join(', ')}
                    </div>`
                    : '';
                
                messageCard.innerHTML = `
                    <div class="message-header">
                        <h4>${msgData.nombre}</h4>
                        <span class="message-id">ID: ${msgData.id}</span>
                    </div>
                    ${variablesList}
                    <div class="form-group">
                        <label>Texto del Mensaje:</label>
                        <textarea 
                            class="message-textarea" 
                            data-flow="${flowKey}" 
                            data-message="${msgKey}"
                            rows="4">${escapeHtml(msgData.texto)}</textarea>
                    </div>
                `;
                
                messagesList.appendChild(messageCard);
            });
        });
    } catch (error) {
        console.error('Error cargando mensajes:', error);
        const container = document.getElementById('messages-container');
        if (container) {
            container.innerHTML = `<p class="loading-text" style="color: var(--danger-color);">Error cargando mensajes: ${error.message}</p>`;
        }
    }
}

// Guardar todos los mensajes
document.getElementById('save-all-messages')?.addEventListener('click', async () => {
    const statusDiv = document.getElementById('messages-status');
    
    try {
        // Recopilar todos los mensajes editados
        const textareas = document.querySelectorAll('.message-textarea');
        textareas.forEach(textarea => {
            const flowKey = textarea.getAttribute('data-flow');
            const msgKey = textarea.getAttribute('data-message');
            const newText = textarea.value;
            
            if (messagesData[flowKey] && messagesData[flowKey].mensajes[msgKey]) {
                messagesData[flowKey].mensajes[msgKey].texto = newText;
            }
        });
        
        // Enviar al servidor
        const response = await fetch('/api/messages', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: messagesData })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            statusDiv.className = 'status-message success';
            statusDiv.textContent = '✅ Todos los mensajes guardados correctamente';
            setTimeout(() => {
                statusDiv.className = 'status-message';
                statusDiv.textContent = '';
            }, 3000);
        } else {
            throw new Error(data.error || 'Error al guardar');
        }
    } catch (error) {
        statusDiv.className = 'status-message error';
        statusDiv.textContent = `❌ Error: ${error.message}`;
    }
});

// Guardar configuración
document.getElementById('config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusDiv = document.getElementById('config-status');
    
    const config = {
        business: {
            nombre: document.getElementById('business-name').value,
            direccion: document.getElementById('business-address').value
        },
        horarios: {
            martes_sabado: document.getElementById('horarios-martes-sabado').value,
            domingos: document.getElementById('horarios-domingos').value
        },
        catalogo: {
            link: document.getElementById('catalogo-link').value
        },
        precios: {
            precio_base: parseInt(document.getElementById('precio-base').value) || 0
        },
        staffPhones: document.getElementById('staff-phones').value
            .split('\n').map(s => s.trim()).filter(Boolean),
        adminPhone: document.getElementById('admin-phone').value,
        botPhone: document.getElementById('bot-phone').value
    };
    
    try {
        const response = await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        
        const data = await response.json();
        
        if (response.ok) {
            statusDiv.className = 'status-message success';
            statusDiv.textContent = '✅ Configuración guardada correctamente';
            setTimeout(() => {
                statusDiv.className = 'status-message';
                statusDiv.textContent = '';
            }, 3000);
        } else {
            throw new Error(data.error || 'Error al guardar');
        }
    } catch (error) {
        statusDiv.className = 'status-message error';
        statusDiv.textContent = `❌ Error: ${error.message}`;
    }
});

// Utilidades
function formatPhone(phone) {
    if (!phone) return 'N/A';
    if (phone.length > 10) {
        return `+${phone}`;
    }
    return phone;
}

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (minutes < 1) return 'Hace un momento';
    if (minutes < 60) return `Hace ${minutes} min`;
    if (hours < 24) return `Hace ${hours} hora${hours > 1 ? 's' : ''}`;
    if (days < 7) return `Hace ${days} día${days > 1 ? 's' : ''}`;
    
    return date.toLocaleDateString('es-MX', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatAppointmentDate(dateString) {
    if (!dateString) return 'N/A';
    
    if (dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [year, month, day] = dateString.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        return date.toLocaleDateString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }
    
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    } catch (error) {
        return dateString;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateStatus(connected) {
    // Esta función ya no es necesaria ya que removimos el indicador de estado del HTML
    // La dejamos aquí para evitar errores si se llama desde algún lugar
    // No hace nada porque los elementos ya no existen
    return;
}

// Exponer función globalmente para onclick
window.selectConversation = selectConversation;

async function downloadSnapshot() {
    try {
        const res = await fetch('/api/export-snapshot');
        if (!res.ok) throw new Error('Error al exportar');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const fecha = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        a.href = url;
        a.download = `snapshot-${fecha}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('No se pudo descargar el snapshot: ' + err.message);
    }
}
window.downloadSnapshot = downloadSnapshot;

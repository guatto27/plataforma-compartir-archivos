'use strict';

// Pipeline (roadmap) de las fases del proyecto. Estructura fija por ahora; se hará
// editable más adelante. Se comparte entre el portal del cliente y el del admin.
const PIPELINE = [
  {
    state: 'current', label: 'En curso', name: 'Diagnóstico y Levantamiento', sub: 'Levantamiento del estado actual',
    items: [
      {
        n: 1, state: 'current', stateLabel: 'En proceso',
        t: 'Levantamiento de Requerimientos', paso: 'Paso 1 · Captura de Información',
        desc: 'Conversamos contigo y tu equipo para entender cómo funciona tu operación hoy. Identificamos tus retos, necesidades y objetivos para que el proyecto esté alineado desde el inicio con lo que realmente importa para tu organización.',
      },
      {
        n: 2, state: 'pending', stateLabel: 'Pendiente',
        t: 'Mapeo de Procesos Actuales (As-Is)', paso: 'Paso 2 · Diagnóstico Fotográfico',
        desc: 'Documentamos de forma visual cómo opera tu organización hoy. Detectamos los cuellos de botella, tareas repetitivas y áreas de mejora en tus procesos actuales para tener un diagnóstico claro y objetivo.',
      },
      {
        n: 3, state: 'pending', stateLabel: 'Pendiente',
        t: 'Informe de Integración de Hallazgos', paso: 'Paso 3 · Análisis y Cruce de Datos',
        desc: 'Consolidamos toda la información recopilada en un informe ejecutivo. Te presentamos los hallazgos clave, las brechas identificadas entre tu operación actual y tu potencial, y las oportunidades concretas de mejora con IA.',
      },
      {
        n: 4, state: 'pending', stateLabel: 'Pendiente',
        t: 'Mapeo de Procesos Deseados (To-Be)', paso: 'Paso 4 · Rediseño Optimizado',
        desc: 'Diseñamos juntos cómo debería operar tu organización con IA integrada. Te mostramos el proceso ideal: optimizado, automatizado y listo para implementar, con una visión clara del cambio que verás en tu operación.',
      },
    ],
    entregable: 'Diagnóstico y Levantamiento',
  },
  {
    state: 'pending', label: 'Pendiente', name: 'Rediseño To-Be', sub: 'Arquitectura futura con IA',
    items: [
      { t: 'Arquitectura de procesos To-Be', s: '' },
      { t: 'Puntos de fricción + IA estratégica', s: '' },
      { t: 'Business case de automatización', s: '' },
    ],
    entregable: 'Modelo To-Be aprobado por el cliente',
  },
  {
    state: 'pending', label: 'Pendiente', name: 'Desarrollo a la medida', sub: 'Construcción y despliegue',
    items: [
      { t: 'MVP de la solución de IA', s: '' },
      { t: 'Integración con sistemas core', s: '' },
    ],
    entregable: 'Solución en producción',
  },
  {
    state: 'pending', label: 'Pendiente', name: 'Implementación y cierre', sub: 'Pruebas · capacitación · cierre',
    items: [
      { t: 'Pruebas y ajustes', s: '' },
      { t: 'Capacitación y entrega', s: '' },
    ],
    entregable: 'Acta de cierre del proyecto',
  },
];

module.exports = { PIPELINE };

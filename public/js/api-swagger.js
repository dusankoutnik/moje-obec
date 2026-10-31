// Swagger UI pro /api — inicializace mimo HTML (CSP script-src 'self'); specifikace z data-openapi.
(function () {
  'use strict';
  var el = document.getElementById('swagger-ui');
  if (!el || !window.SwaggerUIBundle) return;
  window.ui = window.SwaggerUIBundle({
    url: el.getAttribute('data-openapi'),
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    displayRequestDuration: true,
    persistAuthorization: true,
    tryItOutEnabled: false,
  });
})();

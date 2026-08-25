{{- define "umoja-wazuh.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "umoja-wazuh.namespace" -}}
{{- default (include "umoja-wazuh.name" .) .Values.namespaceOverride -}}
{{- end -}}

package nativeidem

import (
	"testing"

	"github.com/gruntwork-io/terratest/modules/helm"
	"github.com/stretchr/testify/require"
)

func TestNativeIdemHelmRendersFailClosedMultiAZWorkload(t *testing.T) {
	t.Parallel()
	options := &helm.Options{SetValues: map[string]string{
		"image.digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"objectStorage.endpoint": "https://s3-compatible.invalid",
		"objectStorage.bucket": "umoja-release-evidence",
		"vault.address": "https://vault.invalid",
		"vault.objectStorageSecretPath": "secret/data/umoja/object-storage",
	}}
	rendered := helm.RenderTemplate(t, options, "../../../deploy/helm/umoja-payment-engine", "umoja-payment-engine")
	require.Contains(t, rendered, "topologySpreadConstraints:")
	require.Contains(t, rendered, "topology.kubernetes.io/zone")
	require.Contains(t, rendered, "name: opa")
	require.Contains(t, rendered, "UMOJA_IDEM_OPA_ENDPOINT")
	require.Contains(t, rendered, "@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	require.Contains(t, rendered, "readOnlyRootFilesystem: true")
}

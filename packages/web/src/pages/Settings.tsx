import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog } from '@/components/ui/Dialog';
import { AlertTriangle, DatabaseZap, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export function Settings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const [localSettings, setLocalSettings] = useState<any>(settings);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetPhrase, setResetPhrase] = useState('');

  useEffect(() => {
    if (settings) setLocalSettings(settings);
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: (data: any) => api.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.fullReset(resetPhrase),
    onSuccess: () => {
      queryClient.clear();
      setShowResetDialog(false);
      setResetPhrase('');
      window.location.assign('/dashboard');
    },
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  const handleSave = () => {
    updateMutation.mutate(localSettings);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Settings</h1>
        <p className="text-gray-400">Configure Encorr</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Auto Scan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-white">Enable Auto Scan</label>
              <p className="text-sm text-gray-400">Automatically scan for new files</p>
            </div>
            <Checkbox
              checked={localSettings?.autoScan?.enabled === 'true' || localSettings?.autoScan?.enabled === true}
              onChange={(e) => setLocalSettings({
                ...localSettings,
                autoScan: { ...localSettings?.autoScan, enabled: e.target.checked }
              })}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-white">Interval (minutes)</label>
            <Input
              type="number"
              value={localSettings?.autoScan?.intervalMinutes || 60}
              onChange={(e) => setLocalSettings({
                ...localSettings,
                autoScan: { ...localSettings?.autoScan, intervalMinutes: parseInt(e.target.value) }
              })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>File Retention</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-white">Delete Original</label>
              <p className="text-sm text-gray-400">Delete original file after successful transcoding</p>
            </div>
            <Checkbox
              checked={localSettings?.fileRetention?.deleteOriginal === 'true' || localSettings?.fileRetention?.deleteOriginal === true}
              onChange={(e) => setLocalSettings({
                ...localSettings,
                fileRetention: { ...localSettings?.fileRetention, deleteOriginal: e.target.checked }
              })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-white">Keep Backup</label>
              <p className="text-sm text-gray-400">Keep backup before deleting</p>
            </div>
            <Checkbox
              checked={localSettings?.fileRetention?.keepBackup === 'true' || localSettings?.fileRetention?.keepBackup === true}
              onChange={(e) => setLocalSettings({
                ...localSettings,
                fileRetention: { ...localSettings?.fileRetention, keepBackup: e.target.checked }
              })}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={updateMutation.isPending}>
          <Save className="mr-2 h-4 w-4" />
          Save Settings
        </Button>
      </div>

      <Card style={{ backgroundColor: 'rgba(127, 29, 29, 0.12)', border: '1px solid rgba(248, 113, 113, 0.3)' }}>
        <CardHeader>
          <CardTitle>
            <span className="flex items-center gap-2 text-red-300"><DatabaseZap className="h-5 w-5" />Danger zone</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <p className="font-medium text-white">Full system reset</p>
              <p className="mt-1 text-sm leading-6 text-gray-400">
                Cancel all queued and active work, disconnect every worker, delete the complete <code className="rounded bg-black/20 px-1 py-0.5 text-red-200">.encorr</code> data directory, then recreate a clean database with built-in presets.
              </p>
            </div>
            <Button
              onClick={() => {
                setResetPhrase('');
                resetMutation.reset();
                setShowResetDialog(true);
              }}
              className="shrink-0 border border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"
            >
              <Trash2 className="mr-2 h-4 w-4" />Full reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={showResetDialog}
        onClose={() => !resetMutation.isPending && setShowResetDialog(false)}
        title="Permanently reset Encorr?"
        size="md"
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              onClick={() => setShowResetDialog(false)}
              disabled={resetMutation.isPending}
              className="border border-[#39363a] text-gray-300"
            >
              Cancel
            </Button>
            <Button
              onClick={() => resetMutation.mutate()}
              disabled={resetPhrase !== 'RESET ENCORR' || resetMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {resetMutation.isPending ? 'Resetting…' : 'Delete everything'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-red-500/35 bg-red-500/10 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
              <div>
                <p className="font-semibold text-red-100">This cannot be undone.</p>
                <p className="mt-1.5 text-sm leading-6 text-red-100/70">
                  Libraries, scans, mappings, custom presets, settings, queues, job history, reports, storage statistics, node registrations and cached Encorr data will all be removed. Media files outside <code>.encorr</code> are not deleted.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-gray-300">Type <strong className="font-mono text-white">RESET ENCORR</strong> to continue</label>
            <Input
              value={resetPhrase}
              onChange={event => setResetPhrase(event.target.value)}
              disabled={resetMutation.isPending}
              placeholder="RESET ENCORR"
              autoComplete="off"
            />
          </div>

          {resetMutation.isError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {resetMutation.error instanceof Error ? resetMutation.error.message : 'The reset could not be completed.'}
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}

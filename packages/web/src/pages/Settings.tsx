import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Save } from 'lucide-react';
import { useState } from 'react';

export function Settings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const [localSettings, setLocalSettings] = useState<any>(settings);

  const updateMutation = useMutation({
    mutationFn: (data: any) => api.updateSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
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
              checked={settings?.autoScan?.enabled === 'true' || settings?.autoScan?.enabled === true}
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
              value={settings?.autoScan?.intervalMinutes || 60}
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
              checked={settings?.fileRetention?.deleteOriginal === 'true' || settings?.fileRetention?.deleteOriginal === true}
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
              checked={settings?.fileRetention?.keepBackup === 'true' || settings?.fileRetention?.keepBackup === true}
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
    </div>
  );
}

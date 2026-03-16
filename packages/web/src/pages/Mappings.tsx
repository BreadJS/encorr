import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/utils/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Trash2, Plus, FolderTree } from 'lucide-react';

export function Mappings() {
  const queryClient = useQueryClient();

  const { data: mappings, isLoading } = useQuery({
    queryKey: ['mappings'],
    queryFn: () => api.getMappings(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteMapping(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mappings'] });
    },
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Folder Mappings</h1>
          <p className="text-muted-foreground">Map server paths to node paths</p>
        </div>
        <Button onClick={() => console.log('Add mapping dialog not implemented')}>
          <Plus className="mr-2 h-4 w-4" />
          Add Mapping
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {mappings?.map((mapping: any) => (
          <Card key={mapping.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <FolderTree className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-lg">{mapping.node_name}</CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm('Delete this mapping?')) {
                      deleteMutation.mutate(mapping.id);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <span className="text-muted-foreground">Server Path:</span>
                <p className="font-mono mt-1 rounded bg-muted p-2">{mapping.server_path}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Node Path:</span>
                <p className="font-mono mt-1 rounded bg-muted p-2">{mapping.node_path}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Watch:</span>
                <span className={mapping.watch ? 'text-green-600' : 'text-gray-600'}>
                  {mapping.watch ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}

        {mappings?.length === 0 && (
          <Card className="col-span-full">
            <CardContent className="py-12 text-center text-muted-foreground">
              <FolderTree className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No folder mappings configured</p>
              <p className="text-sm mt-2">Add a mapping to start discovering video files</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
